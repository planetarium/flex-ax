import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeWatermarkFile, type WatermarkFile } from "./index.js";

describe("normalizeWatermarkFile", () => {
  it("returns {} for non-object roots (array, null, primitive)", () => {
    assert.deepEqual(normalizeWatermarkFile([]), {});
    assert.deepEqual(normalizeWatermarkFile(null), {});
    assert.deepEqual(normalizeWatermarkFile("garbage"), {});
    assert.deepEqual(normalizeWatermarkFile(42), {});
  });

  it("drops domains whose state is not a plain object", () => {
    const result = normalizeWatermarkFile({
      approvalDocuments: [1, 2, 3],
      timeOff: null,
    });
    assert.deepEqual(result, {});
  });

  it("substitutes empty groups when groups is missing or non-object", () => {
    const result = normalizeWatermarkFile({
      approvalDocuments: { groups: "not-an-object" },
      other: { groups: [1, 2] },
    });
    assert.deepEqual(result.approvalDocuments, { groups: {}, lastFullReconAt: undefined });
    assert.deepEqual(result.other, { groups: {}, lastFullReconAt: undefined });
  });

  it("drops malformed group entries while keeping well-formed siblings", () => {
    const raw = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T12:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
          done: { lastUpdatedAt: 123 }, // wrong type → drop
          junk: null,
        },
        lastFullReconAt: "2026-04-20T00:00:00Z",
      },
    };
    const result = normalizeWatermarkFile(raw);
    const wm = result.approvalDocuments!;
    assert.equal(Object.keys(wm.groups).length, 1);
    assert.ok(wm.groups["in-progress"]);
    assert.equal(wm.lastFullReconAt, "2026-04-20T00:00:00Z");
  });

  it("keeps a group when only lastUpdatedAt is present (informational fields are optional)", () => {
    const result = normalizeWatermarkFile({
      approvalDocuments: {
        groups: {
          "in-progress": { lastUpdatedAt: "2026-04-29T12:00:00Z" },
        },
      },
    });
    const g = result.approvalDocuments!.groups["in-progress"];
    assert.equal(g.lastUpdatedAt, "2026-04-29T12:00:00Z");
    assert.equal(g.overlapDays, undefined);
    assert.equal(g.lastSuccessfulRunAt, undefined);
  });

  it("omits out-of-range overlapDays but keeps the group", () => {
    const result = normalizeWatermarkFile({
      approvalDocuments: {
        groups: {
          neg: { lastUpdatedAt: "2026-04-29T12:00:00Z", overlapDays: -1 },
          tooBig: { lastUpdatedAt: "2026-04-29T12:00:00Z", overlapDays: 100000 },
          fractional: { lastUpdatedAt: "2026-04-29T12:00:00Z", overlapDays: 1.5 },
          nan: { lastUpdatedAt: "2026-04-29T12:00:00Z", overlapDays: Number.NaN },
          ok: { lastUpdatedAt: "2026-04-29T12:00:00Z", overlapDays: 2 },
        },
      },
    });
    const groups = result.approvalDocuments!.groups;
    for (const label of ["neg", "tooBig", "fractional", "nan"]) {
      assert.ok(groups[label], `group ${label} must survive`);
      assert.equal(groups[label].overlapDays, undefined);
    }
    assert.equal(groups.ok.overlapDays, 2);
  });

  it("preserves a well-formed file unchanged in shape", () => {
    const raw: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T12:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
        },
        lastFullReconAt: "2026-04-20T00:00:00Z",
      },
    };
    const result = normalizeWatermarkFile(raw);
    assert.deepEqual(result, raw);
  });
});
