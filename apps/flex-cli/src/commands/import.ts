import { existsSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Config } from "../config/index.js";
import { createLogger, type Logger } from "../logger/index.js";
import { importToSqlite } from "../db/import.js";

export async function runImport(): Promise<void> {
  const logger = createLogger("IMPORT");

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const customerDirs = await discoverCustomerDirs(config.outputDir, logger);

  if (customerDirs.length === 0) {
    // 레거시(법인 분리 전) 구조 폴백
    if (hasCrawlArtifacts(config.outputDir)) {
      // FLEX_CUSTOMERS 필터가 있는데 법인 구조 자체가 없으면 사용자 의도와 어긋남 — 중단
      if (config.customers.length > 0) {
        logger.error(
          "FLEX_CUSTOMERS가 지정됐지만 outputDir이 법인별로 분리되어 있지 않습니다. " +
            "크롤을 먼저 실행해 법인별 디렉토리를 생성하거나, 필터를 제거해 주세요.",
          { customers: config.customers, outputDir: config.outputDir },
        );
        process.exit(1);
      }
      await importOne(config.outputDir, config.outputDir, logger);
      return;
    }
    logger.error("임포트할 데이터가 없습니다", { outputDir: config.outputDir });
    process.exit(1);
  }

  // customers 필터가 있으면 해당 법인만
  const targets =
    config.customers.length > 0
      ? customerDirs.filter((d) => config.customers.includes(path.basename(d)))
      : customerDirs;

  if (targets.length === 0) {
    logger.error("요청한 법인에 해당하는 데이터가 없습니다", { customers: config.customers });
    process.exit(1);
  }

  logger.info("법인별 임포트 시작", { count: targets.length });

  for (const dir of targets) {
    await importOne(dir, dir, logger);
  }
}

async function importOne(sourceDir: string, dbDir: string, logger: Logger): Promise<void> {
  const dbPath = path.resolve(dbDir, "flex-ax.db");
  logger.info(`${sourceDir}/ → ${dbPath}`);

  const result = await importToSqlite(sourceDir, dbPath, logger);

  console.log(`[FLEX-AX:IMPORT] 임포트 완료: ${dbPath}`);
  console.log(`[FLEX-AX:IMPORT] templates=${result.templates}, instances=${result.instances}, attendance=${result.attendance}`);
  console.log(`[FLEX-AX:IMPORT] users=${result.users}, fields=${result.fieldValues}, approvals=${result.approvalLines}, comments=${result.comments}, attachments=${result.attachments}`);
}

/**
 * outputDir 바로 아래에서 크롤 아티팩트(templates/ 등)를 가진 하위 디렉토리를 찾는다.
 * 각 하위 디렉토리는 하나의 법인(customerIdHash)에 해당한다.
 *
 * 경로가 존재하지 않거나 읽기에 실패하면 빈 배열을 반환한다 — 호출부가
 * "법인 분리 없음"으로 간주해 레거시 단일 구조 폴백으로 이어갈 수 있게 한다.
 */
async function discoverCustomerDirs(
  outputDir: string,
  logger: Logger,
): Promise<string[]> {
  if (!existsSync(outputDir)) return [];
  let entries: Dirent[];
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    logger.warn("output 디렉토리 스캔 실패 — 단일 구조로 폴백합니다", {
      outputDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(outputDir, entry.name);
    if (hasCrawlArtifacts(full)) dirs.push(full);
  }
  return dirs;
}

function hasCrawlArtifacts(dir: string): boolean {
  return (
    existsSync(path.join(dir, "templates")) ||
    existsSync(path.join(dir, "instances")) ||
    existsSync(path.join(dir, "attendance")) ||
    existsSync(path.join(dir, "endpoints"))
  );
}
