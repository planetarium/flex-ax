import type { AuthContext } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { StorageWriter } from "../storage/index.js";
import type { ApiCatalog, CatalogEntry } from "../types/catalog.js";
import {
  type CrawlResult,
  delay,
  emptyCrawlResult,
  nowISO,
  withRetry,
  flexFetch,
  flexPost,
} from "./shared.js";

/** 기존 전용 크롤러(template/instance/attendance)가 이미 처리하므로 여기서는 스킵 */
const HANDLED_BY_DEDICATED_CRAWLERS = new Set([
  "template-list",
  "template-detail",
  "instance-search",
  "instance-detail",
  "time-off-uses",
]);

/**
 * 카탈로그의 모든 분류된 엔드포인트를 순회하며 데이터를 수집한다.
 * 기존 전용 크롤러(template, instance, attendance)가 처리하는 항목은 제외.
 */
export async function crawlCatalogEndpoints(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult> {
  const startTime = Date.now();
  const result = emptyCrawlResult();

  if (!catalog) {
    logger.warn("카탈로그 없음 — 카탈로그 엔드포인트 크롤링 건너뜀");
    return result;
  }

  // 같은 id의 엔트리를 중복 제거 (첫 번째만 사용).
  // 안전을 위해 read-only 메서드(GET/POST search 류)만 수집 대상으로 삼는다.
  // PUT/PATCH/DELETE는 서버 상태를 변경할 수 있으므로 크롤러에서 호출하지 않는다.
  const seenIds = new Set<string>();
  const uniqueEntries: CatalogEntry[] = [];
  for (const entry of catalog.entries) {
    if (!entry.id) continue;
    if (HANDLED_BY_DEDICATED_CRAWLERS.has(entry.id)) continue;
    if (entry.method !== "GET" && entry.method !== "POST") {
      logger.info(
        `카탈로그 엔드포인트 스킵: ${entry.id} (method=${entry.method}, 읽기 전용 아님)`,
      );
      continue;
    }
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    uniqueEntries.push(entry);
  }

  logger.info(`카탈로그 엔드포인트 수집 시작: ${uniqueEntries.length}개 대상`);
  result.totalCount = uniqueEntries.length;

  for (let i = 0; i < uniqueEntries.length; i++) {
    const entry = uniqueEntries[i];
    const endpointId = entry.id!;
    const url = `${config.flexBaseUrl}${entry.exampleUrl}`;

    logger.info(`[${i + 1}/${uniqueEntries.length}] ${entry.method} ${endpointId}`);

    try {
      const data = await withRetry(
        () =>
          entry.method === "POST"
            ? flexPost<unknown>(authCtx, url, entry.requestBodySample ?? {})
            : flexFetch<unknown>(authCtx, url),
        { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
      );

      await storage.saveEndpointData(endpointId, {
        endpointId,
        method: entry.method,
        url: entry.exampleUrl,
        discoveredFrom: entry.discoveredFrom,
        menuLabel: entry.menuLabel,
        crawledAt: nowISO(),
        data,
      });

      result.successCount++;
    } catch (error) {
      result.failureCount++;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`실패: ${endpointId} — ${message}`);
      result.errors.push({
        target: `endpoint:${endpointId}`,
        phase: "fetch",
        message,
        timestamp: nowISO(),
      });
    }

    await delay(config.requestDelayMs);
  }

  result.durationMs = Date.now() - startTime;
  logger.info(
    `카탈로그 엔드포인트 수집 완료: 성공 ${result.successCount}, 실패 ${result.failureCount}`,
  );
  return result;
}
