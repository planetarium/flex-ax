import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import {
  normalizeWatermarkFile,
  type CrawlReport,
  type StorageWriter,
  type WatermarkFile,
} from "../storage/index.js";
import { crawlInstances } from "./instance.js";
import { toKstDate } from "./shared.js";

interface CapturedFetch {
  url: string;
  method: string;
  body: unknown;
}

const ORIGINAL_FETCH = globalThis.fetch;

function makeAuth(): AuthContext {
  return {
    baseUrl: "https://flex.test",
    deviceId: "device-1",
    workspaceToken: "ws-token",
    refreshToken: "rt-token",
    customerToken: "ct-token",
  };
}

function makeConfig(): Config {
  return {
    flexEmail: "",
    flexPassword: "",
    flexBaseUrl: "https://flex.test",
    outputDir: "./output",
    catalogPath: "./output/api-catalog.json",
    requestDelayMs: 0,
    maxRetries: 0,
    concurrency: 2,
    attachmentConcurrency: 1,
    searchPageSize: 100,
    downloadAttachments: false,
    crawlSensitive: false,
    skipEndpoints: [],
    customers: [],
    flexCrawlMode: "incremental",
  };
}

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    progress: () => {},
  };
}

interface FakeStorage extends StorageWriter {
  _instances: unknown[];
  _watermarks: WatermarkFile;
  _existingInstanceKeys: Set<string>;
}

function makeStorage(
  initial: WatermarkFile = {},
  existingInstanceKeys: Set<string> = new Set(),
): FakeStorage {
  let watermarks: WatermarkFile = structuredClone(initial);
  const instances: unknown[] = [];
  const writer: FakeStorage = {
    saveTemplate: async () => {},
    saveInstance: async (i) => {
      instances.push(i);
    },
    saveAttendanceApproval: async () => {},
    saveAttachment: async () => "",
    saveEndpointData: async () => {},
    saveReport: async (_r: CrawlReport) => {},
    saveCatalog: async () => {},
    // Mirror the production storage by routing reads through the
    // normalizer. Tests that seed pathological initial state (invalid
    // lastUpdatedAt, future timestamps, etc.) thus exercise the same
    // self-heal path the real disk path does.
    loadWatermarks: async () => normalizeWatermarkFile(structuredClone(watermarks)),
    saveWatermarks: async (file) => {
      watermarks = structuredClone(file);
    },
    listExistingInstanceKeys: async () => new Set(existingInstanceKeys),
    _instances: instances,
    _existingInstanceKeys: existingInstanceKeys,
    get _watermarks() {
      return watermarks;
    },
  } as FakeStorage;
  return writer;
}

interface SearchResp {
  documents: Array<{
    document: { documentKey: string; lastUpdatedAt?: string };
  }>;
  total: number;
  hasNext: boolean;
  continuationToken?: string;
}

interface DetailResp {
  document: {
    documentKey: string;
    code: string;
    templateKey: string;
    status: string;
    title: string;
    writer: { idHash: string; name: string };
    writtenAt: string;
    inputs: unknown[];
    updatedAt: string;
  };
  approvalProcess?: { status: string; lines: unknown[] };
}

function detailFor(docKey: string, updatedAt: string, status = "DONE"): DetailResp {
  return {
    document: {
      documentKey: docKey,
      code: docKey,
      templateKey: "tmpl-1",
      status,
      title: "doc",
      writer: { idHash: "u1", name: "tester" },
      writtenAt: "2026-01-01T00:00:00Z",
      inputs: [],
      updatedAt,
    },
    approvalProcess: { status: "DONE", lines: [] },
  };
}

function setupFetch(
  searchResponses: Map<string, SearchResp>,
  details: Map<string, DetailResp>,
  failDetailFor: Set<string> = new Set(),
): { calls: CapturedFetch[] } {
  const calls: CapturedFetch[] = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });

    if (url.includes("/user-boxes/search")) {
      const statuses: string[] = body?.filter?.statuses ?? [];
      const key = statuses.sort().join("|");
      const resp = searchResponses.get(key);
      if (!resp) {
        return new Response(JSON.stringify({ documents: [], total: 0, hasNext: false }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(resp), { status: 200 });
    }

    // Detail GET: /api/v3/approval-document/approval-documents/<docKey>
    const docKey = url.split("/").pop()!;
    if (failDetailFor.has(docKey)) {
      return new Response("boom", { status: 500 });
    }
    const detail = details.get(docKey);
    if (!detail) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(detail), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

describe("crawlInstances incremental wiring", () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("bootstraps without lastUpdatedDateRange when no watermark exists, then writes one", async () => {
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "d1" } }], total: 1, hasNext: false },
      ],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "d2" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["d1", detailFor("d1", "2026-04-29T12:00:00Z", "IN_PROGRESS")],
      ["d2", detailFor("d2", "2026-04-30T03:00:00Z", "DONE")],
    ]);
    const { calls } = setupFetch(search, details);

    const storage = makeStorage();
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.successCount, 2);
    const searchCalls = calls.filter((c) => c.url.includes("/user-boxes/search"));
    for (const c of searchCalls) {
      const filter = (c.body as { filter: Record<string, unknown> }).filter;
      assert.ok(
        !("lastUpdatedDateRange" in filter),
        "bootstrap must not send lastUpdatedDateRange",
      );
    }

    const wm = storage._watermarks.approvalDocuments!;
    // in-progress is incrementalEligible=false: never persisted as a
    // group watermark, even after a successful sweep. Only done lands.
    assert.equal(wm.groups["in-progress"], undefined);
    assert.equal(wm.groups["done"].lastUpdatedAt, "2026-04-30T03:00:00Z");
    assert.ok(wm.lastFullReconAt, "bootstrap counts as a full recon");
  });

  it("injects lastUpdatedDateRange (KST) when watermarks exist and mode=incremental", async () => {
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T12:17:44Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
          done: {
            lastUpdatedAt: "2026-04-25T03:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const { calls } = setupFetch(search, new Map());

    // Capture today both before and after the crawl so that an
    // (extremely rare) KST-midnight crossing during the test doesn't
    // make the comparison flaky — `to` must equal whichever value the
    // crawl observed when it built todayKst.
    const todayBefore = toKstDate(new Date());
    await crawlInstances(makeAuth(), makeConfig(), null, makeStorage(initial), makeLogger());
    const todayAfter = toKstDate(new Date());
    const acceptableTodays = new Set([todayBefore, todayAfter]);

    // in-progress is incrementalEligible=false: must always sweep with
    // no lastUpdatedDateRange, even when a stale watermark sits in the
    // file (e.g. left over from a pre-policy run).
    const inProgressCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        Array.isArray((c.body as { filter: { statuses: string[] } }).filter.statuses) &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses[0] === "IN_PROGRESS",
    );
    assert.ok(inProgressCall);
    const ipFilter = (inProgressCall.body as { filter: Record<string, unknown> }).filter;
    assert.ok(
      !("lastUpdatedDateRange" in ipFilter),
      "in-progress must never carry a date range",
    );

    const doneCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses.includes("DONE"),
    );
    assert.ok(doneCall);
    const doneRange = (
      (doneCall.body as { filter: { lastUpdatedDateRange: { from: string; to: string } } })
        .filter.lastUpdatedDateRange
    );
    assert.equal(doneRange.from, "2026-04-23"); // KST(2026-04-25 12:00 KST) - 2d
    assert.ok(acceptableTodays.has(doneRange.to), `to=${doneRange.to} must be a today-KST value`);
  });

  it("mode=full ignores existing watermarks and skips lastUpdatedDateRange", async () => {
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T12:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const { calls } = setupFetch(search, new Map());

    await crawlInstances(
      makeAuth(),
      makeConfig(),
      null,
      makeStorage(initial),
      makeLogger(),
      "full",
    );

    const searchCalls = calls.filter((c) => c.url.includes("/user-boxes/search"));
    for (const c of searchCalls) {
      const filter = (c.body as { filter: Record<string, unknown> }).filter;
      assert.ok(
        !("lastUpdatedDateRange" in filter),
        "full mode must not send lastUpdatedDateRange",
      );
    }
  });

  it("does not advance the done watermark when that group has any failure", async () => {
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          done: {
            lastUpdatedAt: "2026-04-29T00:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-29T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      [
        "CANCELED|DECLINED|DONE",
        {
          documents: [
            { document: { documentKey: "done-ok" } },
            { document: { documentKey: "done-fail" } },
          ],
          total: 2,
          hasNext: false,
        },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["done-ok", detailFor("done-ok", "2026-05-04T05:00:00Z", "DONE")],
    ]);
    setupFetch(search, details, new Set(["done-fail"]));

    const storage = makeStorage(initial);
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.failureCount, 1);
    assert.equal(
      storage._watermarks.approvalDocuments!.groups["done"].lastUpdatedAt,
      "2026-04-29T00:00:00Z",
      "any failure in the group blocks the watermark advance",
    );
  });

  it("treats an invalid watermark.lastUpdatedAt as bootstrap for that group", async () => {
    // Simulates a corrupted/hand-edited watermark file that survived
    // normalization (e.g., string field present but unparseable). The
    // done group must omit lastUpdatedDateRange so the run self-heals
    // into a full crawl rather than aborting on RangeError.
    const initial = {
      approvalDocuments: {
        groups: {
          done: {
            lastUpdatedAt: "garbage",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
        },
      },
    } as unknown as WatermarkFile;

    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "done-ok" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["done-ok", detailFor("done-ok", "2026-05-05T01:00:00Z", "DONE")],
    ]);
    const { calls } = setupFetch(search, details);

    const storage = makeStorage(initial);
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.failureCount, 0);
    const doneCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses.includes("DONE"),
    );
    assert.ok(doneCall);
    const filter = (doneCall.body as { filter: Record<string, unknown> }).filter;
    assert.ok(
      !("lastUpdatedDateRange" in filter),
      "invalid watermark must self-heal by omitting the date range",
    );
    // After a clean run, the corrupted watermark is replaced with the
    // observed max — the file repairs itself.
    assert.equal(
      storage._watermarks.approvalDocuments!.groups["done"].lastUpdatedAt,
      "2026-05-05T01:00:00Z",
    );
  });

  it("self-heals a future-dated watermark by treating that group as bootstrap", async () => {
    // Hand-edit / clock-skew: stored watermark is in the future. Without
    // self-heal, computeDateRange would emit `from > to` and the search
    // would return nothing forever.
    const initial = {
      approvalDocuments: {
        groups: {
          done: {
            lastUpdatedAt: "2099-01-01T00:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2099-01-01T00:00:00Z",
          },
        },
      },
    } as WatermarkFile;

    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "done-ok" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["done-ok", detailFor("done-ok", "2026-05-05T01:00:00Z", "DONE")],
    ]);
    const { calls } = setupFetch(search, details);

    const storage = makeStorage(initial);
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    // done had a bad watermark → group dropped at normalize → no
    // lastUpdatedDateRange in the done search.
    const doneCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses.includes("DONE"),
    );
    assert.ok(doneCall);
    const filter = (doneCall.body as { filter: Record<string, unknown> }).filter;
    assert.ok(
      !("lastUpdatedDateRange" in filter),
      "future watermark must self-heal by omitting the date range",
    );
    // Watermark replaced by the freshly observed value.
    assert.equal(
      storage._watermarks.approvalDocuments!.groups["done"].lastUpdatedAt,
      "2026-05-05T01:00:00Z",
    );
  });

  it("records a structured error when saveWatermarks fails", async () => {
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    setupFetch(search, new Map());

    const storage = makeStorage();
    storage.saveWatermarks = async () => {
      throw new Error("disk full");
    };

    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    const saveErr = result.errors.find((e) => e.phase === "save-watermark");
    assert.ok(saveErr, "save-watermark failure must surface in result.errors");
    assert.equal(saveErr.target, "instance-watermark");
    assert.match(saveErr.message, /disk full/);
  });

  it("uses epoch-ms comparison so trailing-Z and millisecond forms order correctly", async () => {
    // Stored watermark "...44Z" is *earlier* in time than a candidate
    // "...44.500Z", but a naive lexicographic comparison would place the
    // candidate first and refuse to advance. epoch-ms comparison fixes it.
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          done: {
            lastUpdatedAt: "2026-04-29T12:17:44Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-29T12:17:44Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "ms-doc" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["ms-doc", detailFor("ms-doc", "2026-04-29T12:17:44.500Z", "DONE")],
    ]);
    setupFetch(search, details);

    const storage = makeStorage(initial);
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(
      storage._watermarks.approvalDocuments!.groups["done"].lastUpdatedAt,
      "2026-04-29T12:17:44.500Z",
      "candidate is later in time and must replace the watermark",
    );
  });

  it("stamps lastSuccessfulRunAt on a clean zero-doc run while preserving lastUpdatedAt", async () => {
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          done: {
            lastUpdatedAt: "2026-04-29T12:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    setupFetch(search, new Map());

    const storage = makeStorage(initial);
    const before = Date.now();
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    const wm = storage._watermarks.approvalDocuments!.groups["done"];
    assert.equal(wm.lastUpdatedAt, "2026-04-29T12:00:00Z", "lastUpdatedAt must be preserved");
    assert.ok(wm.lastSuccessfulRunAt, "lastSuccessfulRunAt must be set");
    const stamped = Date.parse(wm.lastSuccessfulRunAt!);
    assert.ok(stamped >= before, "lastSuccessfulRunAt must be from this run, not the prior one");
  });

  it("stamps lastFullReconAt on a clean zero-doc bootstrap full crawl", async () => {
    // Customer has no approval documents (or no access). The crawl
    // should still record a recon marker — otherwise cadence-based
    // auto-promotion can never advance away from this state.
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    setupFetch(search, new Map());

    const storage = makeStorage();
    const before = Date.now();
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.successCount, 0);
    assert.equal(result.failureCount, 0);
    const stamped = storage._watermarks.approvalDocuments?.lastFullReconAt;
    assert.ok(stamped, "clean zero-doc full crawl must stamp lastFullReconAt");
    assert.ok(Date.parse(stamped!) >= before);
  });

  it("reports docKeys present on disk but missing from a full recon", async () => {
    // disk had d-old1 and d-old2; this run sees d-old1 (still alive) and
    // d-new (newly created). d-old2 disappeared from the flex listing.
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "d-old1" } }], total: 1, hasNext: false },
      ],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "d-new" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["d-old1", detailFor("d-old1", "2026-05-01T00:00:00Z", "IN_PROGRESS")],
      ["d-new", detailFor("d-new", "2026-05-04T00:00:00Z", "DONE")],
    ]);
    setupFetch(search, details);

    const storage = makeStorage({}, new Set(["d-old1", "d-old2"]));
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.deepEqual(result.missingKeys, ["d-old2"]);
  });

  it("returns empty missingKeys when the full recon collected every disk key", async () => {
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "d-only" } }], total: 1, hasNext: false },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const details = new Map<string, DetailResp>([
      ["d-only", detailFor("d-only", "2026-05-01T00:00:00Z", "IN_PROGRESS")],
    ]);
    setupFetch(search, details);

    const storage = makeStorage({}, new Set(["d-only"]));
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.deepEqual(result.missingKeys, []);
  });

  it("does not compute missing diff in incremental mode (avoids false positives)", async () => {
    // With a watermark in place the run is incremental and only touches
    // changed docs — disk-vs-collected diff would be hugely noisy.
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-01T00:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-01T00:00:00Z",
          },
          done: {
            lastUpdatedAt: "2026-04-01T00:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-01T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    setupFetch(search, new Map());

    const storage = makeStorage(initial, new Set(["d-historical-1", "d-historical-2"]));
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.deepEqual(result.missingKeys, []);
  });

  it("withholds missing diff when the full recon had any failure (avoids false positives)", async () => {
    // d-fail couldn't be re-fetched this run, so it landed in
    // failureCount, not collectedKeys-as-success. Reporting it as
    // missing would mislead operators.
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        {
          documents: [
            { document: { documentKey: "d-ok" } },
            { document: { documentKey: "d-fail" } },
          ],
          total: 2,
          hasNext: false,
        },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const details = new Map<string, DetailResp>([
      ["d-ok", detailFor("d-ok", "2026-05-01T00:00:00Z", "IN_PROGRESS")],
    ]);
    setupFetch(search, details, new Set(["d-fail"]));

    const storage = makeStorage({}, new Set(["d-ok", "d-fail", "d-historical"]));
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.failureCount, 1);
    assert.deepEqual(result.missingKeys, []);
  });

  it("withholds lastFullReconAt and missingKeys when the list stage throws", async () => {
    // crawlSearchGroup throws after retries (search API is permanently
    // failing). result.errors records an `instance-list` entry but
    // failureCount stays at 0 because no doc-level work happened — the
    // listStageOk flag must still block the full-recon outcomes.
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/user-boxes/search")) {
        return new Response("server error", { status: 500 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const storage = makeStorage({}, new Set(["d-historical"]));
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.ok(
      result.errors.some((e) => e.target === "instance-list"),
      "list-stage error must be recorded",
    );
    assert.equal(result.failureCount, 0, "no doc-level failures occurred");
    assert.equal(
      storage._watermarks.approvalDocuments?.lastFullReconAt,
      undefined,
      "list-stage throw must not stamp lastFullReconAt",
    );
    assert.deepEqual(
      result.missingKeys,
      [],
      "list-stage throw must withhold the missing diff (collectedKeys is partial)",
    );
  });

  it("does not stamp lastFullReconAt when a bootstrap full crawl had any failure", async () => {
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "fail-doc" } }], total: 1, hasNext: false },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    setupFetch(search, new Map(), new Set(["fail-doc"]));

    const storage = makeStorage();
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.failureCount, 1);
    assert.equal(
      storage._watermarks.approvalDocuments?.lastFullReconAt,
      undefined,
      "lastFullReconAt must not be stamped when the recon had failures",
    );
  });

  it("never regresses a watermark when observed max is older than stored", async () => {
    // The stored watermark must be a plausible (non-future) timestamp,
    // since the normalizer now drops future watermarks. Pick a recent
    // date and observe an even-older one.
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          done: {
            lastUpdatedAt: "2026-05-01T00:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-05-01T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      ["IN_PROGRESS", { documents: [], total: 0, hasNext: false }],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "old-doc" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["old-doc", detailFor("old-doc", "2026-04-01T00:00:00Z", "DONE")],
    ]);
    setupFetch(search, details);

    const storage = makeStorage(initial);
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(
      storage._watermarks.approvalDocuments!.groups["done"].lastUpdatedAt,
      "2026-05-01T00:00:00Z",
    );
  });

  it("always sweeps in-progress without a date range and never persists a watermark for it", async () => {
    // Even with a stale watermark file claiming an in-progress group
    // entry (e.g. left over from before this policy or hand-edited),
    // the search payload must omit lastUpdatedDateRange and the entry
    // must not survive a clean run.
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T00:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-29T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "ip-1" } }], total: 1, hasNext: false },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const details = new Map<string, DetailResp>([
      ["ip-1", detailFor("ip-1", "2026-05-05T01:00:00Z", "IN_PROGRESS")],
    ]);
    const { calls } = setupFetch(search, details);

    const storage = makeStorage(initial);
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    const inProgressCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses[0] === "IN_PROGRESS",
    );
    assert.ok(inProgressCall);
    const filter = (inProgressCall.body as { filter: Record<string, unknown> }).filter;
    assert.ok(
      !("lastUpdatedDateRange" in filter),
      "in-progress must always sweep without a date range",
    );
    // The stale entry from `initial` is left in place by the file's
    // shape (we don't actively delete it), but a successful sweep must
    // not advance lastSuccessfulRunAt for it — that's the only externally
    // visible signal that the policy is in effect.
    const wmIp = storage._watermarks.approvalDocuments?.groups["in-progress"];
    assert.equal(
      wmIp?.lastSuccessfulRunAt,
      "2026-04-29T00:00:00Z",
      "in-progress watermark must not be touched by the sweep",
    );
  });
});
