/**
 * 429 한계점 탐색용 probe.
 *
 * 인증한 뒤 인스턴스 검색 페이지(20건)의 documentKey들을 모아두고,
 * 그 중 일부를 N개 워커로 동시 GET해서 throughput / 429 / 에러율을 측정한다.
 *
 * 사용법:
 *   FLEX_PROBE_CONCURRENCY=8 FLEX_PROBE_REQUESTS=80 \
 *     pnpm --filter flex-crawler exec tsx src/probe.ts
 */
import { loadConfig } from "./config/index.js";
import { authenticate, apiHeaders } from "./auth/index.js";
import { createLogger } from "./logger/index.js";

interface ProbeStats {
  concurrency: number;
  total: number;
  ok: number;
  status429: number;
  otherErrors: number;
  durationMs: number;
  rps: number;
  latencyP50: number;
  latencyP95: number;
  latencyMax: number;
}

async function fetchDocumentKeys(
  baseUrl: string,
  headers: Record<string, string>,
  needed: number,
): Promise<string[]> {
  const keys: string[] = [];
  let lastDocumentKey: string | undefined;

  while (keys.length < needed) {
    const body = {
      filter: {
        statuses: ["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"],
        templateKeys: [],
        writerHashedIds: [],
        approverTargets: [],
        referrerTargets: [],
        starred: false,
      },
      search: { keyword: "", type: "ALL" },
      ...(lastDocumentKey ? { lastDocumentKey } : {}),
    };
    const res = await fetch(
      `${baseUrl}/action/v3/approval-document/user-boxes/search?size=20&sortType=LAST_UPDATED_AT&direction=DESC`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new Error(`search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      hasNext: boolean;
      documents: Array<{ document: { documentKey: string } }>;
    };
    const docs = data.documents ?? [];
    if (docs.length === 0) break;
    for (const d of docs) keys.push(d.document.documentKey);
    if (!data.hasNext) break;
    lastDocumentKey = docs[docs.length - 1].document.documentKey;
  }
  return keys.slice(0, needed);
}

async function runProbe(
  baseUrl: string,
  headers: Record<string, string>,
  documentKeys: string[],
  concurrency: number,
): Promise<ProbeStats> {
  const total = documentKeys.length;
  const latencies: number[] = [];
  let ok = 0;
  let status429 = 0;
  let otherErrors = 0;
  let nextIdx = 0;

  const start = Date.now();

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= total) return;
      const key = documentKeys[idx];
      const t0 = Date.now();
      try {
        const res = await fetch(
          `${baseUrl}/api/v3/approval-document/approval-documents/${key}`,
          { headers },
        );
        const dt = Date.now() - t0;
        latencies.push(dt);
        if (res.status === 429) {
          status429++;
          // body 비워서 connection reuse
          await res.text().catch(() => "");
        } else if (!res.ok) {
          otherErrors++;
          await res.text().catch(() => "");
        } else {
          ok++;
          await res.text().catch(() => "");
        }
      } catch (err) {
        otherErrors++;
        latencies.push(Date.now() - t0);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const durationMs = Date.now() - start;
  latencies.sort((a, b) => a - b);
  const pct = (p: number): number =>
    latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

  return {
    concurrency,
    total,
    ok,
    status429,
    otherErrors,
    durationMs,
    rps: total > 0 ? (total / durationMs) * 1000 : 0,
    latencyP50: pct(0.5),
    latencyP95: pct(0.95),
    latencyMax: latencies.length ? latencies[latencies.length - 1] : 0,
  };
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function parseList(name: string, fallback: number[]): number[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

async function main(): Promise<void> {
  const logger = createLogger();
  const config = loadConfig();
  const ctx = await authenticate(config, logger);
  const headers = apiHeaders(ctx);
  const baseUrl = config.flexBaseUrl;

  const requestsPerLevel = envInt("FLEX_PROBE_REQUESTS", 80);
  const concurrencyLevels = parseList("FLEX_PROBE_LEVELS", [1, 4, 8, 16, 32]);
  const cooldownMs = envInt("FLEX_PROBE_COOLDOWN_MS", 3000);

  logger.info("documentKey 수집...");
  const keys = await fetchDocumentKeys(baseUrl, headers, requestsPerLevel);
  logger.info(`확보된 documentKey: ${keys.length}건`);
  if (keys.length < 20) {
    logger.warn("documentKey 표본이 너무 적습니다. 결과 신뢰도가 낮을 수 있습니다.");
  }

  const results: ProbeStats[] = [];
  for (const concurrency of concurrencyLevels) {
    logger.info(`\n=== probe: concurrency=${concurrency}, requests=${keys.length} ===`);
    const stats = await runProbe(baseUrl, headers, keys, concurrency);
    results.push(stats);
    logger.info(
      `c=${stats.concurrency} ok=${stats.ok}/${stats.total} 429=${stats.status429} err=${stats.otherErrors} ` +
        `rps=${stats.rps.toFixed(2)} p50=${stats.latencyP50}ms p95=${stats.latencyP95}ms max=${stats.latencyMax}ms ` +
        `dur=${stats.durationMs}ms`,
    );
    if (stats.status429 > 0) {
      logger.warn(`429 발생 — 다음 단계 중단`);
      break;
    }
    if (cooldownMs > 0) {
      await new Promise((r) => setTimeout(r, cooldownMs));
    }
  }

  console.log("\n=== summary ===");
  console.log("concurrency\tok\t429\terr\trps\tp50\tp95\tdur(ms)");
  for (const s of results) {
    console.log(
      `${s.concurrency}\t\t${s.ok}\t${s.status429}\t${s.otherErrors}\t${s.rps.toFixed(2)}\t${s.latencyP50}\t${s.latencyP95}\t${s.durationMs}`,
    );
  }
}

main().catch((err) => {
  console.error("probe 실패:", err);
  process.exit(1);
});
