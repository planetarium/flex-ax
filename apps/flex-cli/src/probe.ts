/**
 * 동시성 한계점 + 검색 endpoint 페이지네이션 동작 확인용 진단 스크립트.
 *
 * 사용:
 *   FLEX_PROBE_LEVELS=1,4,8,16,32 FLEX_PROBE_REQUESTS=120 \
 *     pnpm --filter flex-ax exec tsx src/probe.ts
 *
 * 첫 페이즈: search endpoint에 continuationToken 페이지네이션이 실제 동작하는지 검사.
 * 두번째 페이즈: detail GET에 동시성 단계별로 부하를 가하면서 429 / latency / RPS 측정.
 */
import { loadConfig } from "./config/index.js";
import { authenticate, apiHeaders, listCorporations, switchCustomer } from "./auth/index.js";
import { createLogger } from "./logger/index.js";

interface SearchResp {
  total: number;
  hasNext: boolean;
  continuationToken?: string;
  documents: Array<{ document: { documentKey: string } }>;
}

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

async function searchPage(
  baseUrl: string,
  headers: Record<string, string>,
  size: number,
  statuses: string[],
  continuationToken?: string,
): Promise<SearchResp> {
  const params = new URLSearchParams({ size: String(size), sortType: "LAST_UPDATED_AT", direction: "DESC" });
  if (continuationToken) params.set("continuationToken", continuationToken);
  const body = {
    filter: {
      statuses,
      templateKeys: [],
      writerHashedIds: [],
      approverTargets: [],
      referrerTargets: [],
      starred: false,
    },
    search: { keyword: "", type: "ALL" },
  };
  const res = await fetch(
    `${baseUrl}/action/v3/approval-document/user-boxes/search?${params.toString()}`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  if (!res.ok) throw new Error(`search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as SearchResp;
}

async function checkPagination(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string[]> {
  // 모든 status 합쳐서 검사
  const statuses = ["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"];
  const all: string[] = [];
  const seen = new Set<string>();
  let continuationToken: string | undefined;
  let pageNo = 0;

  console.log("\n=== pagination probe (size=20, continuationToken) ===");
  while (pageNo < 10) {
    const page = await searchPage(baseUrl, headers, 20, statuses, continuationToken);
    pageNo++;
    const keys = page.documents.map((d) => d.document.documentKey);
    const newKeys = keys.filter((k) => !seen.has(k));
    for (const k of keys) seen.add(k);
    all.push(...newKeys);
    console.log(
      `  page ${pageNo}: total=${page.total} returned=${keys.length} new=${newKeys.length} ` +
        `hasNext=${page.hasNext} nextToken=${page.continuationToken?.slice(0, 12) ?? "null"}`,
    );
    if (!page.hasNext) break;
    if (!page.continuationToken) {
      console.log("  -> 토큰 없음, 종료");
      break;
    }
    if (page.continuationToken === continuationToken) {
      console.log("  -> 토큰 정체, 종료");
      break;
    }
    if (newKeys.length === 0) {
      console.log("  -> 동일 docKey 반복, 종료");
      break;
    }
    continuationToken = page.continuationToken;
  }
  console.log(`  collected unique=${seen.size}`);

  // 큰 size 한 방으로도 시도
  const big = await searchPage(baseUrl, headers, 1000, statuses);
  console.log(
    `\n=== single-shot size=1000 ===\n  total=${big.total} returned=${big.documents.length} hasNext=${big.hasNext}`,
  );
  return Array.from(seen).length > 0 ? Array.from(seen) : big.documents.map((d) => d.document.documentKey);
}

async function runDetailProbe(
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
        if (res.status === 429) status429++;
        else if (!res.ok) otherErrors++;
        else ok++;
        await res.text().catch(() => "");
      } catch {
        latencies.push(Date.now() - t0);
        otherErrors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const durationMs = Date.now() - start;
  latencies.sort((a, b) => a - b);
  const pct = (p: number): number =>
    latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

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
  return Number.isNaN(n) ? fallback : n;
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
  const logger = createLogger("PROBE");
  const config = loadConfig();
  const ctx = await authenticate(config, logger);
  // 첫 법인으로 customer token 발급
  const corps = await listCorporations(ctx, config.flexBaseUrl);
  if (corps.length === 0) throw new Error("법인 없음");
  await switchCustomer(ctx, config.flexBaseUrl, corps[0].customerIdHash, corps[0].userIdHash);
  logger.info(`프로브 대상 법인: ${corps[0].name}`);

  const headers = apiHeaders(ctx);

  const keys = await checkPagination(config.flexBaseUrl, headers);

  const requestsPerLevel = envInt("FLEX_PROBE_REQUESTS", Math.min(keys.length, 200));
  const sample = keys.slice(0, requestsPerLevel);
  if (sample.length === 0) {
    console.log("문서 0건 — detail probe 스킵");
    return;
  }

  const concurrencyLevels = parseList("FLEX_PROBE_LEVELS", [1, 4, 8, 16, 32, 64]);
  const cooldownMs = envInt("FLEX_PROBE_COOLDOWN_MS", 2000);

  const results: ProbeStats[] = [];
  for (const concurrency of concurrencyLevels) {
    console.log(`\n=== detail probe: c=${concurrency}, requests=${sample.length} ===`);
    const stats = await runDetailProbe(config.flexBaseUrl, headers, sample, concurrency);
    results.push(stats);
    console.log(
      `  c=${stats.concurrency} ok=${stats.ok}/${stats.total} 429=${stats.status429} err=${stats.otherErrors} ` +
        `rps=${stats.rps.toFixed(2)} p50=${stats.latencyP50}ms p95=${stats.latencyP95}ms max=${stats.latencyMax}ms`,
    );
    if (stats.status429 > 0) {
      console.log("  -> 429 발견, 다음 단계 중단");
      break;
    }
    if (cooldownMs > 0) await new Promise((r) => setTimeout(r, cooldownMs));
  }

  console.log("\n=== summary ===");
  console.log("c\tok\t429\terr\trps\tp50\tp95\tdur");
  for (const s of results) {
    console.log(
      `${s.concurrency}\t${s.ok}\t${s.status429}\t${s.otherErrors}\t${s.rps.toFixed(2)}\t${s.latencyP50}\t${s.latencyP95}\t${s.durationMs}`,
    );
  }
}

main().catch((err) => {
  console.error("probe 실패:", err);
  process.exit(1);
});
