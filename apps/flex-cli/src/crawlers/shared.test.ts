import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLaterIso, toKstDate, withRetry } from "./shared.js";

describe("isLaterIso", () => {
  it("compares by epoch ms, not lexicographically", () => {
    // ms-bearing string is lexicographically smaller than the trailing-Z
    // form even though it's later in time. Compare:
    //   "2026-04-29T12:17:44.500Z"  <  "2026-04-29T12:17:44Z"  (lex)
    //   500ms later                  >  baseline               (time)
    assert.equal(isLaterIso("2026-04-29T12:17:44.500Z", "2026-04-29T12:17:44Z"), true);
    assert.equal(isLaterIso("2026-04-29T12:17:44Z", "2026-04-29T12:17:44.500Z"), false);
  });

  it("treats null/undefined baseline as -infinity", () => {
    assert.equal(isLaterIso("2026-01-01T00:00:00Z", null), true);
    assert.equal(isLaterIso("2026-01-01T00:00:00Z", undefined), true);
  });

  it("never promotes an invalid candidate over any baseline", () => {
    assert.equal(isLaterIso("not-a-date", null), false);
    assert.equal(isLaterIso("", "2026-01-01T00:00:00Z"), false);
    assert.equal(isLaterIso(null, null), false);
  });

  it("treats invalid baseline as -infinity (any valid candidate wins)", () => {
    assert.equal(isLaterIso("2026-01-01T00:00:00Z", "garbage"), true);
  });
});

describe("withRetry onRetry callback", () => {
  it("invokes onRetry once per actual retry with 0-based attempt index", async () => {
    const seen: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("boom");
        return "ok";
      },
      {
        maxRetries: 5,
        delayMs: 0,
        onRetry: (attempt) => {
          seen.push(attempt);
        },
      },
    );
    assert.equal(result, "ok");
    // 3번 호출 = 2번 재시도 직전에 콜백. attempt는 직전 실패 시도의 0-base 인덱스.
    assert.deepEqual(seen, [0, 1]);
  });

  it("does not invoke onRetry when maxRetries is exhausted", async () => {
    let onRetryCalls = 0;
    let fnCalls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          fnCalls++;
          throw new Error("always");
        },
        {
          maxRetries: 2,
          delayMs: 0,
          onRetry: () => {
            onRetryCalls++;
          },
        },
      ),
    );
    // 총 3회 호출(초기 + 재시도 2회), 콜백은 재시도 직전 2회만.
    assert.equal(fnCalls, 3);
    assert.equal(onRetryCalls, 2);
  });

  it("swallows errors thrown by onRetry so retry loop continues", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
        return "recovered";
      },
      {
        maxRetries: 3,
        delayMs: 0,
        onRetry: () => {
          throw new Error("instrumentation broken");
        },
      },
    );
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  it("does not invoke onRetry when shouldRetry rejects the error", async () => {
    let onRetryCalls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error("non-retriable");
        },
        {
          maxRetries: 5,
          delayMs: 0,
          shouldRetry: () => false,
          onRetry: () => {
            onRetryCalls++;
          },
        },
      ),
    );
    assert.equal(onRetryCalls, 0);
  });
});

describe("toKstDate", () => {
  it("returns YYYY-MM-DD in Asia/Seoul", () => {
    assert.equal(toKstDate("2026-04-29T12:17:44Z"), "2026-04-29");
  });

  it("crosses the date boundary on UTC midnight (KST = UTC+9)", () => {
    // UTC 16:00 of day N → KST 01:00 of day N+1
    assert.equal(toKstDate("2026-04-29T16:00:00Z"), "2026-04-30");
    // UTC 14:59 of day N → still KST 23:59 of day N
    assert.equal(toKstDate("2026-04-29T14:59:00Z"), "2026-04-29");
  });

  it("accepts Date and number inputs", () => {
    const ms = Date.parse("2026-04-29T12:17:44Z");
    assert.equal(toKstDate(new Date(ms)), "2026-04-29");
    assert.equal(toKstDate(ms), "2026-04-29");
  });
});
