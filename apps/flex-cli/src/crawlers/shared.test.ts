import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toKstDate } from "./shared.js";

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
