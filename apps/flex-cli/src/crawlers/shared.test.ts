import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLaterIso, toKstDate } from "./shared.js";

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
