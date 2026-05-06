import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type {
  CrawlReport,
  StorageWriter,
  WatermarkFile,
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
}

function makeStorage(initial: WatermarkFile = {}): FakeStorage {
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
    loadWatermarks: async () => structuredClone(watermarks),
    saveWatermarks: async (file) => {
      watermarks = structuredClone(file);
    },
    _instances: instances,
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
    assert.equal(wm.groups["in-progress"].lastUpdatedAt, "2026-04-29T12:00:00Z");
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

    await crawlInstances(makeAuth(), makeConfig(), null, makeStorage(initial), makeLogger());

    const today = toKstDate(new Date());
    const inProgressCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        Array.isArray((c.body as { filter: { statuses: string[] } }).filter.statuses) &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses[0] === "IN_PROGRESS",
    );
    assert.ok(inProgressCall);
    const ipFilter = (inProgressCall.body as { filter: Record<string, unknown> }).filter;
    assert.deepEqual(ipFilter.lastUpdatedDateRange, {
      from: "2026-04-28", // KST(2026-04-29 21:17 KST) - 1d = 2026-04-28
      to: today,
    });

    const doneCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses.includes("DONE"),
    );
    assert.ok(doneCall);
    const doneFilter = (doneCall.body as { filter: Record<string, unknown> }).filter;
    assert.deepEqual(doneFilter.lastUpdatedDateRange, {
      from: "2026-04-23", // KST(2026-04-25 12:00 KST) - 2d = 2026-04-23
      to: today,
    });
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

  it("does not advance a group's watermark when that group has any failure", async () => {
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T00:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-29T00:00:00Z",
          },
          done: {
            lastUpdatedAt: "2026-04-29T00:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-29T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        {
          documents: [
            { document: { documentKey: "ip-ok" } },
            { document: { documentKey: "ip-fail" } },
          ],
          total: 2,
          hasNext: false,
        },
      ],
      [
        "CANCELED|DECLINED|DONE",
        { documents: [{ document: { documentKey: "done-ok" } }], total: 1, hasNext: false },
      ],
    ]);
    const details = new Map<string, DetailResp>([
      ["ip-ok", detailFor("ip-ok", "2026-05-03T01:00:00Z", "IN_PROGRESS")],
      ["done-ok", detailFor("done-ok", "2026-05-04T05:00:00Z", "DONE")],
    ]);
    const { calls: _calls } = setupFetch(search, details, new Set(["ip-fail"]));

    const storage = makeStorage(initial);
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.failureCount, 1);
    assert.equal(result.successCount, 2);

    // in-progress had 1 failure → watermark must be unchanged
    assert.equal(
      storage._watermarks.approvalDocuments!.groups["in-progress"].lastUpdatedAt,
      "2026-04-29T00:00:00Z",
    );
    // done was clean → watermark advances to the observed max
    assert.equal(
      storage._watermarks.approvalDocuments!.groups["done"].lastUpdatedAt,
      "2026-05-04T05:00:00Z",
    );
  });

  it("treats an invalid watermark.lastUpdatedAt as bootstrap for that group", async () => {
    // Simulates a corrupted/hand-edited watermark file that survived
    // normalization (e.g., string field present but unparseable). The
    // group must omit lastUpdatedDateRange so the run self-heals into a
    // full crawl rather than aborting on RangeError.
    const initial = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "garbage",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
          done: {
            lastUpdatedAt: "2026-04-25T00:00:00Z",
            overlapDays: 2,
            lastSuccessfulRunAt: "2026-04-30T00:00:00Z",
          },
        },
      },
    } as unknown as WatermarkFile;

    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "ip-ok" } }], total: 1, hasNext: false },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const details = new Map<string, DetailResp>([
      ["ip-ok", detailFor("ip-ok", "2026-05-05T01:00:00Z", "IN_PROGRESS")],
    ]);
    const { calls } = setupFetch(search, details);

    const storage = makeStorage(initial);
    const result = await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(result.failureCount, 0);
    const inProgressCall = calls.find(
      (c) =>
        c.url.includes("/user-boxes/search") &&
        (c.body as { filter: { statuses: string[] } }).filter.statuses[0] === "IN_PROGRESS",
    );
    assert.ok(inProgressCall);
    const filter = (inProgressCall.body as { filter: Record<string, unknown> }).filter;
    assert.ok(
      !("lastUpdatedDateRange" in filter),
      "invalid watermark must self-heal by omitting the date range",
    );
    // After a clean run, the corrupted watermark is replaced with the
    // observed max — the file repairs itself.
    assert.equal(
      storage._watermarks.approvalDocuments!.groups["in-progress"].lastUpdatedAt,
      "2026-05-05T01:00:00Z",
    );
  });

  it("uses epoch-ms comparison so trailing-Z and millisecond forms order correctly", async () => {
    // Stored watermark "...44Z" is *earlier* in time than a candidate
    // "...44.500Z", but a naive lexicographic comparison would place the
    // candidate first and refuse to advance. epoch-ms comparison fixes it.
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2026-04-29T12:17:44Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2026-04-29T12:17:44Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "ms-doc" } }], total: 1, hasNext: false },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const details = new Map<string, DetailResp>([
      ["ms-doc", detailFor("ms-doc", "2026-04-29T12:17:44.500Z", "IN_PROGRESS")],
    ]);
    setupFetch(search, details);

    const storage = makeStorage(initial);
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(
      storage._watermarks.approvalDocuments!.groups["in-progress"].lastUpdatedAt,
      "2026-04-29T12:17:44.500Z",
      "candidate is later in time and must replace the watermark",
    );
  });

  it("never regresses a watermark when observed max is older than stored", async () => {
    const initial: WatermarkFile = {
      approvalDocuments: {
        groups: {
          "in-progress": {
            lastUpdatedAt: "2099-01-01T00:00:00Z",
            overlapDays: 1,
            lastSuccessfulRunAt: "2099-01-01T00:00:00Z",
          },
        },
      },
    };
    const search = new Map<string, SearchResp>([
      [
        "IN_PROGRESS",
        { documents: [{ document: { documentKey: "old-doc" } }], total: 1, hasNext: false },
      ],
      ["CANCELED|DECLINED|DONE", { documents: [], total: 0, hasNext: false }],
    ]);
    const details = new Map<string, DetailResp>([
      ["old-doc", detailFor("old-doc", "2026-04-01T00:00:00Z", "IN_PROGRESS")],
    ]);
    setupFetch(search, details);

    const storage = makeStorage(initial);
    await crawlInstances(makeAuth(), makeConfig(), null, storage, makeLogger());

    assert.equal(
      storage._watermarks.approvalDocuments!.groups["in-progress"].lastUpdatedAt,
      "2099-01-01T00:00:00Z",
    );
  });
});
