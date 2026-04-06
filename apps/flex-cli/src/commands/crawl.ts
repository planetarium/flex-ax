import { readFile } from "node:fs/promises";
import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { authenticate, cleanup } from "../auth/index.js";
import { createStorageWriter, type CrawlReport } from "../storage/index.js";
import type { ApiCatalog } from "../types/catalog.js";
import { crawlTemplates } from "../crawlers/template.js";
import { crawlInstances } from "../crawlers/instance.js";
import { crawlAttendanceApprovals } from "../crawlers/attendance.js";
import type { CrawlError } from "../types/common.js";
import type { CrawlResult } from "../crawlers/shared.js";

export async function runCrawl(): Promise<void> {
  const logger = createLogger("CRAWL");

  let config;
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
  let authCtx;
  try {
    authCtx = await authenticate(config, logger);
  } catch (error) {
    logger.error("인증 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const storage = createStorageWriter(config.outputDir, config.catalogPath);
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  let templateResult: CrawlResult = { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };
  let instanceResult: CrawlResult = { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };
  let attendanceResult: CrawlResult = { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };

  try {
    templateResult = await crawlTemplates(authCtx, config, catalog, storage, logger);
    const instanceCrawlResult = await crawlInstances(authCtx, config, catalog, storage, logger);
    instanceResult = instanceCrawlResult;
    attendanceResult = await crawlAttendanceApprovals(
      authCtx, config, catalog, storage, logger, instanceCrawlResult.collectedKeys,
    );
  } finally {
    await cleanup(authCtx);
  }

  const completedAt = new Date().toISOString();
  const totalErrors: CrawlError[] = [
    ...templateResult.errors,
    ...instanceResult.errors,
    ...attendanceResult.errors,
  ];

  const report: CrawlReport = {
    startedAt,
    completedAt,
    durationMs: Date.now() - startTime,
    templates: templateResult,
    instances: instanceResult,
    attendance: attendanceResult,
    totalErrors,
  };

  await storage.saveReport(report);

  // 구조화된 출력
  console.log(`[FLEX-AX:CRAWL] 크롤링 완료: templates=${templateResult.successCount}, instances=${instanceResult.successCount}, attendance=${attendanceResult.successCount}`);

  if (totalErrors.length > 0) {
    for (const err of totalErrors) {
      console.log(`[FLEX-AX:ERROR] ${err.target}: ${err.message}`);
    }
    process.exit(2);
  }
}
