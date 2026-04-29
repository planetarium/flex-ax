import { loadConfig } from "./config/index.js";
import { authenticate, cleanup } from "./auth/index.js";
import { createLogger } from "./logger/index.js";
import { createStorageWriter, type CrawlReport } from "./storage/index.js";
import { crawlTemplates } from "./crawlers/template.js";
import { crawlInstances } from "./crawlers/instance.js";
import { crawlAttendanceApprovals } from "./crawlers/attendance.js";
import type { CrawlError } from "./types/common.js";
import type { CrawlResult } from "./crawlers/shared.js";

async function main() {
  const logger = createLogger();

  // 1. 설정 로딩
  logger.info("설정 로딩...");
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패. .env 파일을 확인하세요.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
  logger.info("설정 로딩 완료", {
    baseUrl: config.flexBaseUrl,
    outputDir: config.outputDir,
  });

  // 2. 저장소 초기화
  const storage = createStorageWriter(config.outputDir);

  // 3. 인증
  logger.info("flex 인증 시작...");
  let authCtx;
  try {
    authCtx = await authenticate(config, logger);
  } catch (error) {
    logger.error("인증 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  let templateResult: CrawlResult = { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };
  let instanceResult: CrawlResult = { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };
  let attendanceResult: CrawlResult = { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };

  try {
    // 4. 양식(템플릿) 수집
    templateResult = await crawlTemplates(authCtx, config, storage, logger);

    // 5. 인스턴스(결재 문서) 수집
    const instanceCrawlResult = await crawlInstances(authCtx, config, storage, logger);
    instanceResult = instanceCrawlResult;

    // 6. 근태/휴가 승인 수집 (인스턴스에서 수집한 key로 중복 방지)
    attendanceResult = await crawlAttendanceApprovals(
      authCtx,
      config,
      storage,
      logger,
      instanceCrawlResult.collectedKeys,
    );
  } finally {
    // 7. 정리 (현재는 no-op이지만 호환성을 위해 호출)
    await cleanup(authCtx);
  }

  // 8. 결과 요약 및 저장
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
  logger.summary(report);

  // 보안 안내
  logger.info(`\n수집 데이터가 ${config.outputDir}/ 에 저장되었습니다.`);
  logger.info("수집된 데이터에는 민감 정보가 포함될 수 있으므로 접근 관리에 유의하세요.");

  if (totalErrors.length > 0) {
    process.exit(2);
  }
}

main();
