import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_TTL_MS,
  SUCCESS_TTL_MS,
  isCacheFresh,
  isCi,
  isOptedOut,
} from "./auto-update.js";

describe("isOptedOut", () => {
  it("treats false/0/no as opt-out", () => {
    for (const v of ["false", "0", "no"]) {
      assert.equal(isOptedOut({ FLEX_AX_AUTO_UPDATE: v }), true);
    }
  });

  it("treats unset or other values as opt-in", () => {
    assert.equal(isOptedOut({}), false);
    assert.equal(isOptedOut({ FLEX_AX_AUTO_UPDATE: "true" }), false);
    assert.equal(isOptedOut({ FLEX_AX_AUTO_UPDATE: "1" }), false);
    assert.equal(isOptedOut({ FLEX_AX_AUTO_UPDATE: "" }), false);
  });
});

describe("isCi", () => {
  it("returns true for CI=true|1", () => {
    assert.equal(isCi({ CI: "true" }), true);
    assert.equal(isCi({ CI: "1" }), true);
  });

  it("returns false for unset or other values", () => {
    assert.equal(isCi({}), false);
    assert.equal(isCi({ CI: "false" }), false);
    assert.equal(isCi({ CI: "" }), false);
  });
});

describe("isCacheFresh", () => {
  const now = 1_700_000_000_000;

  it("returns false for null cache", () => {
    assert.equal(isCacheFresh(null, now), false);
  });

  it("uses SUCCESS_TTL when latestVersion is set", () => {
    assert.equal(
      isCacheFresh({ checkedAt: now - SUCCESS_TTL_MS + 1, latestVersion: "1.0.0" }, now),
      true,
    );
    assert.equal(
      isCacheFresh({ checkedAt: now - SUCCESS_TTL_MS, latestVersion: "1.0.0" }, now),
      false,
    );
  });

  it("uses FAILURE_TTL when latestVersion is missing", () => {
    assert.equal(isCacheFresh({ checkedAt: now - FAILURE_TTL_MS + 1 }, now), true);
    assert.equal(isCacheFresh({ checkedAt: now - FAILURE_TTL_MS }, now), false);
  });

  it("FAILURE_TTL is shorter than SUCCESS_TTL", () => {
    assert.ok(FAILURE_TTL_MS < SUCCESS_TTL_MS);
  });
});
