import path from "node:path";
import os from "node:os";
import { rm } from "node:fs/promises";
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
import { importToSqlite } from "../db/import.js";
import { importCustomerToFlexHr } from "../flexhr/import.js";

interface DirectDumpContext {
  enabled: boolean;
  baseDir: string | null;
  keepScratch: boolean;
  autoCreatedBaseDir: boolean;
}

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
  const authCtx = await authenticate(config, logger).catch((error) => {
    logger.error("인증 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });

  // 법인(회사) enumerate
  let corporations: Corporation[];
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

  const directDump = createDirectDumpContext(config);
  if (directDump.enabled) {
    logger.info("flex-hr direct dump 모드 활성화", {
      scratchRoot: directDump.baseDir,
      dryRun: config.flexHrImportDryRun,
      storageBackend: config.storageBackend,
    });
  }

  logger.info("법인별 크롤링 시작", {
    count: corporations.length,
    names: corporations.map((c) => c.name),
  });

  const allErrors: CrawlError[] = [];
  try {
    for (const corp of corporations) {
      if (!isSafeIdHash(corp.customerIdHash)) {
        logger.error("customerIdHash 형식이 안전하지 않아 스킵", {
          customerIdHash: corp.customerIdHash,
          name: corp.name,
        });
        allErrors.push({
          target: `customer:${corp.customerIdHash}`,
          phase: "validate-customer",
          message: `unsafe customerIdHash: ${corp.customerIdHash}`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }
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

      const errors = await runCrawlForCustomer(authCtx, config, catalog, corp, logger, directDump);
      allErrors.push(...errors);
    }
  } finally {
    await cleanup(authCtx);
  }

  if (
    directDump.enabled &&
    directDump.baseDir &&
    directDump.autoCreatedBaseDir &&
    !directDump.keepScratch &&
    allErrors.length === 0
  ) {
    await rm(directDump.baseDir, { recursive: true, force: true }).catch(() => undefined);
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
  directDump: DirectDumpContext,
): Promise<CrawlError[]> {
  const customerOutputDir = resolveCustomerOutputDir(config, corp.customerIdHash, directDump);
  const storage: StorageWriter = createStorageWriter(customerOutputDir, config.catalogPath);

  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  let templateResult: CrawlResult = emptyResult();
  let instanceResult: CrawlResult = emptyResult();
  let attendanceResult: CrawlResult = emptyResult();
  let catalogEndpointsResult: CrawlResult = emptyResult();
  let fatalError: CrawlError | null = null;

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
    logger.error("법인 크롤링 중 예외 — 지금까지의 부분 결과를 보고서에 기록합니다", {
      customerIdHash: corp.customerIdHash,
      error: message,
    });
    fatalError = {
      target: `customer:${corp.customerIdHash}`,
      phase: "crawl",
      message,
      timestamp: new Date().toISOString(),
    };
  }

  const completedAt = new Date().toISOString();
  const totalErrors: CrawlError[] = [
    ...templateResult.errors,
    ...instanceResult.errors,
    ...attendanceResult.errors,
    ...catalogEndpointsResult.errors,
  ].map((e) => ({ ...e, target: `${corp.customerIdHash}/${e.target}` }));
  if (fatalError) totalErrors.push(fatalError);

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

  // 예외 상황에서도 디버깅 가능하도록 보고서는 반드시 저장
  try {
    await storage.saveReport(report);
  } catch (saveError) {
    logger.error("크롤 보고서 저장 실패", {
      customerIdHash: corp.customerIdHash,
      error: saveError instanceof Error ? saveError.message : String(saveError),
    });
  }

  const statusLabel = fatalError ? "중단(부분 결과)" : "완료";
  console.log(
    `[FLEX-AX:CRAWL] ${corp.name} (${corp.customerIdHash}) ${statusLabel}: ` +
      `templates=${templateResult.successCount}, instances=${instanceResult.successCount}, ` +
      `attendance=${attendanceResult.successCount}, endpoints=${catalogEndpointsResult.successCount}`,
  );

  if (directDump.enabled) {
    if (totalErrors.length > 0) {
      logger.warn("크롤 오류가 있어 flex-hr direct dump를 스킵합니다", {
        customerIdHash: corp.customerIdHash,
        errors: totalErrors.length,
      });
    } else {
      try {
        const dbPath = path.join(customerOutputDir, "flex-ax.db");
        logger.info("flex-hr direct dump 준비: SQLite 생성", {
          customerIdHash: corp.customerIdHash,
          dbPath,
        });
        await importToSqlite(customerOutputDir, dbPath, logger);
        await importCustomerToFlexHr({
          sourceDir: customerOutputDir,
          customerIdHash: corp.customerIdHash,
          config,
          logger,
        });
        if (directDump.baseDir && directDump.autoCreatedBaseDir && !directDump.keepScratch) {
          await rm(customerOutputDir, { recursive: true, force: true }).catch(() => undefined);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("flex-hr direct dump 실패", {
          customerIdHash: corp.customerIdHash,
          outputDir: customerOutputDir,
          error: message,
        });
        totalErrors.push({
          target: `customer:${corp.customerIdHash}`,
          phase: "flex-hr-direct-dump",
          message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  return totalErrors;
}

function createDirectDumpContext(config: Config): DirectDumpContext {
  if (!config.flexHrDirectDump) {
    return { enabled: false, baseDir: null, keepScratch: true, autoCreatedBaseDir: false };
  }
  const timestampedDir = `flex-ax-flex-hr-dump-${Date.now()}`;
  const configuredBase = config.flexHrScratchRoot.trim().length > 0
    ? path.join(path.resolve(config.flexHrScratchRoot), timestampedDir)
    : path.join(os.tmpdir(), timestampedDir);

  return {
    enabled: true,
    baseDir: configuredBase,
    keepScratch: config.flexHrKeepScratch,
    autoCreatedBaseDir: true,
  };
}

function resolveCustomerOutputDir(
  config: Config,
  customerIdHash: string,
  directDump: DirectDumpContext,
): string {
  if (!directDump.enabled || !directDump.baseDir) {
    return path.join(config.outputDir, customerIdHash);
  }
  return path.join(directDump.baseDir, customerIdHash);
}

/**
 * flex API에서 오는 ID 해시는 통상 영숫자 10자 내외다.
 * 외부 입력이 디렉토리 경로로 쓰이므로 path traversal을 방지하기 위해
 * 허용 문자셋을 엄격히 제한한다.
 */
function isSafeIdHash(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

function emptyResult(): CrawlResult {
  return { totalCount: 0, successCount: 0, failureCount: 0, errors: [], durationMs: 0 };
}
