import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createStorageWriter,
  normalizeWatermarkFile,
  type WatermarkFile,
} from "./index.js";

async function tmpStorageDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "flex-ax-storage-"));
}

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

  it("drops a group whose lastUpdatedAt is empty or whitespace-only", () => {
    const result = normalizeWatermarkFile({
      approvalDocuments: {
        groups: {
          empty: { lastUpdatedAt: "" },
          ws: { lastUpdatedAt: "   \t  " },
          ok: { lastUpdatedAt: "2026-04-29T12:00:00Z" },
        },
      },
    });
    const groups = result.approvalDocuments!.groups;
    assert.equal(groups.empty, undefined);
    assert.equal(groups.ws, undefined);
    assert.ok(groups.ok);
  });

  it("ignores __proto__ / constructor / prototype keys without polluting Object.prototype", () => {
    // JSON.parse turns "__proto__" into an own property, so an
    // attacker-controlled watermark.json could otherwise mutate the
    // base object prototype as soon as we index into it.
    const malicious = JSON.parse(
      '{"__proto__":{"polluted":true},"approvalDocuments":{"groups":{"__proto__":{"lastUpdatedAt":"2026-04-29T12:00:00Z","polluted":true},"constructor":{"lastUpdatedAt":"2026-04-29T12:00:00Z"},"prototype":{"lastUpdatedAt":"2026-04-29T12:00:00Z"},"ok":{"lastUpdatedAt":"2026-04-29T12:00:00Z"}}}}',
    );
    const result = normalizeWatermarkFile(malicious);

    // Object.prototype must still be clean.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);

    // Dangerous keys are dropped at both the domain and the group level;
    // safe siblings survive.
    const groups = result.approvalDocuments!.groups;
    assert.equal(Object.keys(groups).length, 1);
    assert.ok(groups.ok);
  });

  it("drops a group whose lastUpdatedAt is in the future relative to `now`", () => {
    // hand-edited or clock-skewed payload: stored timestamp is later
    // than the supplied `now`. computeDateRange would otherwise emit
    // from > to and wedge incremental crawls.
    const now = Date.parse("2026-05-06T00:00:00Z");
    const result = normalizeWatermarkFile(
      {
        approvalDocuments: {
          groups: {
            future: { lastUpdatedAt: "2099-01-01T00:00:00Z" },
            past: { lastUpdatedAt: "2026-04-29T12:00:00Z" },
          },
        },
      },
      now,
    );
    const groups = result.approvalDocuments!.groups;
    assert.equal(groups.future, undefined);
    assert.ok(groups.past);
  });

  it("does not drop a watermark when the local clock skews a few minutes (same KST date)", () => {
    // Watermark timestamp is "after" `now` in epoch ms but falls on the
    // same KST calendar day. Treating that as a future-drop would make
    // every NTP-skewed run fall back to bootstrap.
    const now = Date.parse("2026-05-06T12:00:00Z");
    const result = normalizeWatermarkFile(
      {
        approvalDocuments: {
          groups: {
            skewed: { lastUpdatedAt: "2026-05-06T12:02:00Z" },
          },
        },
      },
      now,
    );
    assert.ok(result.approvalDocuments!.groups.skewed);
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

describe("createStorageWriter listExistingInstanceKeys", () => {
  it("returns an empty set when the instances directory does not exist", async () => {
    const dir = await tmpStorageDir();
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    const keys = await writer.listExistingInstanceKeys();
    assert.equal(keys.size, 0);
  });

  it("returns docKeys derived from .json filenames, ignoring other entries", async () => {
    const dir = await tmpStorageDir();
    const instancesDir = path.join(dir, "instances");
    await mkdir(instancesDir);
    await writeFile(path.join(instancesDir, "doc-1.json"), "{}", "utf-8");
    await writeFile(path.join(instancesDir, "doc-2.json"), "{}", "utf-8");
    await writeFile(path.join(instancesDir, "README.md"), "ignore me", "utf-8");
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    const keys = await writer.listExistingInstanceKeys();
    assert.deepEqual([...keys].sort(), ["doc-1", "doc-2"]);
  });

  it("does not misclassify a directory whose name ends in .json as a docKey", async () => {
    const dir = await tmpStorageDir();
    const instancesDir = path.join(dir, "instances");
    await mkdir(instancesDir);
    await writeFile(path.join(instancesDir, "real-doc.json"), "{}", "utf-8");
    // A dir whose name ends in .json — readdir returns the bare name
    // and the previous implementation would have called this a docKey.
    await mkdir(path.join(instancesDir, "looks-like-doc.json"));
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    const keys = await writer.listExistingInstanceKeys();
    assert.deepEqual([...keys], ["real-doc"]);
  });
});

describe("createStorageWriter readInstance", () => {
  it("returns null for a missing file (ENOENT)", async () => {
    const dir = await tmpStorageDir();
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    assert.equal(await writer.readInstance("does-not-exist"), null);
  });

  it("returns null when JSON is malformed", async () => {
    const dir = await tmpStorageDir();
    await mkdir(path.join(dir, "instances"));
    await writeFile(path.join(dir, "instances", "bad.json"), "{ not json", "utf-8");
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    assert.equal(await writer.readInstance("bad"), null);
  });

  it("normalizes legacy on-disk shapes that pre-date later columns", async () => {
    // An instance JSON written before signatureHash / lastUpdatedAt /
    // attachments existed must still come back with those slots filled
    // in (as null / []), not undefined, so downstream null-checks and
    // .length reads don't fault.
    const dir = await tmpStorageDir();
    await mkdir(path.join(dir, "instances"));
    const legacy = {
      id: "old",
      documentNumber: "old-1",
      templateId: "t",
      templateName: "t",
      drafter: { id: "u", name: "n" },
      draftedAt: "2025-01-01T00:00:00Z",
      status: "DONE",
      // signatureHash, lastUpdatedAt, attachments, fields, approvalLine all absent
    };
    await writeFile(
      path.join(dir, "instances", "old.json"),
      JSON.stringify(legacy),
      "utf-8",
    );
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    const inst = await writer.readInstance("old");
    assert.ok(inst);
    assert.equal(inst.signatureHash, null);
    assert.equal(inst.lastUpdatedAt, null);
    assert.deepEqual(inst.attachments, []);
    assert.deepEqual(inst.fields, []);
    assert.deepEqual(inst.approvalLine, []);
  });
});

describe("createStorageWriter loadWatermarks", () => {
  it("returns {} when watermark.json is missing (ENOENT)", async () => {
    const dir = await tmpStorageDir();
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    assert.deepEqual(await writer.loadWatermarks(), {});
  });

  it("returns {} when watermark.json contains unparseable JSON", async () => {
    const dir = await tmpStorageDir();
    await writeFile(path.join(dir, "watermark.json"), "{ this is not json", "utf-8");
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    assert.deepEqual(await writer.loadWatermarks(), {});
  });

  it("surfaces unexpected I/O errors instead of falling back to bootstrap", async () => {
    // Triggering a non-ENOENT read error reliably across platforms: make
    // watermark.json a directory. readFile then fails with EISDIR.
    const dir = await tmpStorageDir();
    await mkdir(path.join(dir, "watermark.json"));
    const writer = createStorageWriter(dir, path.join(dir, "catalog.json"));
    await assert.rejects(
      () => writer.loadWatermarks(),
      (err: NodeJS.ErrnoException) =>
        err.code === "EISDIR" || err.code === "EACCES" || err.code === "EPERM",
    );
  });
});
