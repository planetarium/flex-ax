import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig, type Config } from "../config/index.js";
import { createLogger, type Logger } from "../logger/index.js";
import {
  authenticate,
  cleanup,
  listCorporations,
  switchCustomer,
  type AuthContext,
  type Corporation,
} from "../auth/index.js";
import { createStorageWriter, type CrawlReport, type StorageWriter } from "../storage/index.js";
import type { ApiCatalog } from "../types/catalog.js";
import { crawlTemplates } from "../crawlers/template.js";
import { crawlInstances } from "../crawlers/instance.js";
import { crawlAttendanceApprovals } from "../crawlers/attendance.js";
import { crawlCatalogEndpoints } from "../crawlers/catalog-endpoints.js";
import type { CrawlError } from "../types/common.js";
import type { CrawlResult } from "../crawlers/shared.js";

export async function runCrawl(): Promise<void> {
  const logger = createLogger("CRAWL");

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  // 카탈로그 로드 (없으면 하드코딩 폴백)
  let catalog: ApiCatalog | null = null;
  try {
    const content = await readFile(config.catalogPath, "utf-8");
    catalog = JSON.parse(content) as ApiCatalog;
  } catch {
    // 파일 없으면 null
  }
  if (catalog) {
    logger.info("카탈로그 로드 완료", {
      entries: catalog.entries.length,
      unclassified: catalog.unclassified.length,
    });
  } else {
    logger.warn("카탈로그 없음 — 하드코딩 엔드포인트로 폴백합니다");
  }

  // 인증
  let authCtx!: AuthContext;
  try {
    authCtx = await authenticate(config, logger);
  } catch (error) {
    logger.error("인증 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  // 법인(회사) enumerate
  let corporations!: Corporation[];
  try {
    corporations = await listCorporations(authCtx, config.flexBaseUrl);
  } catch (error) {
    await cleanup(authCtx);
    logger.error("법인 목록 조회 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (config.customers.length > 0) {
    const requested = new Set(config.customers);
    corporations = corporations.filter((c) => requested.has(c.customerIdHash));
    const missing = [...requested].filter(
      (id) => !corporations.some((c) => c.customerIdHash === id),
    );
    if (missing.length > 0) {
      logger.warn("요청한 법인이 접근 가능 목록에 없음", { missing });
    }
  }

  if (corporations.length === 0) {
    await cleanup(authCtx);
    logger.error("크롤링할 법인이 없습니다");
    process.exit(1);
  }

  logger.info("법인별 크롤링 시작", {
    count: corporations.length,
    names: corporations.map((c) => c.name),
  });

  const allErrors: CrawlError[] = [];
  try {
    for (const corp of corporations) {
      logger.info("법인 전환", { customerIdHash: corp.customerIdHash, name: corp.name });
      try {
        await switchCustomer(authCtx, config.flexBaseUrl, corp.customerIdHash, corp.userIdHash);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("법인 전환 실패 — 스킵", { customerIdHash: corp.customerIdHash, error: message });
        allErrors.push({
          target: `customer:${corp.customerIdHash}`,
          phase: "switch-customer",
          message,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const errors = await runCrawlForCustomer(authCtx, config, catalog, corp, logger);
      allErrors.push(...errors);
    }
  } finally {
    await cleanup(authCtx);
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) {
      console.log(`[FLEX-AX:ERROR] ${err.target}: ${err.message}`);
    }
    process.exit(2);
  }
}

async function runCrawlForCustomer(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  corp: Corporation,
  logger: Logger,
): Promise<CrawlError[]> {
  const customerOutputDir = path.join(config.outputDir, corp.customerIdHash);
  const storage: StorageWriter = createStorageWriter(customerOutputDir, config.catalogPath);

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  let templateResult: CrawlResult = emptyResult();
  let instanceResult: CrawlResult = emptyResult();
  let attendanceResult: CrawlResult = emptyResult();
  let catalogEndpointsResult: CrawlResult = emptyResult();

  try {
    templateResult = await crawlTemplates(authCtx, config, catalog, storage, logger);
    const instanceCrawlResult = await crawlInstances(authCtx, config, catalog, storage, logger);
    instanceResult = instanceCrawlResult;
    attendanceResult = await crawlAttendanceApprovals(
      authCtx, config, catalog, storage, logger, instanceCrawlResult.collectedKeys,
    );
    catalogEndpointsResult = await crawlCatalogEndpoints(authCtx, config, catalog, storage, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("법인 크롤링 중 예외", { customerIdHash: corp.customerIdHash, error: message });
    return [
      {
        target: `customer:${corp.customerIdHash}`,
        phase: "crawl",
        message,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  const completedAt = new Date().toISOString();
  const totalErrors: CrawlError[] = [
    ...templateResult.errors,
    ...instanceResult.errors,
    ...attendanceResult.errors,
    ...catalogEndpointsResult.errors,
  ].map((e) => ({ ...e, target: `${corp.customerIdHash}/${e.target}` }));

  const report: CrawlReport = {
    startedAt,
    completedAt,
    durationMs: Date.now() - startTime,
    templates: templateResult,
    instances: instanceResult,
    attendance: attendanceResult,
    catalogEndpoints: catalogEndpointsResult,
    totalErrors,
  };

  await storage.saveReport(report);

  console.log(
    `[FLEX-AX:CRAWL] ${corp.name} (${corp.customerIdHash}) 완료: ` +
      `templates=${templateResult.successCount}, instances=${instanceResult.successCount}, ` +
      `attendance=${attendanceResult.successCount}, endpoints=${catalogEndpointsResult.successCount}`,
  );

  return totalErrors;
}

function emptyResult(): CrawlResult {
  return { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };
}
