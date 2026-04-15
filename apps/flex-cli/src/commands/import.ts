import { existsSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Config } from "../config/index.js";
import { createLogger, type Logger } from "../logger/index.js";
import { importToSqlite } from "../db/import.js";
import { resolveFlexDataDir } from "../paths/index.js";

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
    if (hasCrawlArtifacts(config.outputDir)) {
      let resolved: ReturnType<typeof resolveFlexDataDir>;
      try {
        resolved = resolveFlexDataDir(config.outputDir);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      if (config.customers.length > 0) {
        const dirBasename = path.basename(resolved.resolvedPath);
        if (config.customers.includes(dirBasename)) {
          logger.info("outputDir이 특정 법인 디렉토리를 가리킴 — 단일 법인 임포트", {
            customerIdHash: dirBasename,
          });
          await importOne(resolved.resolvedPath, resolved.resolvedPath, logger);
          return;
        }
        logger.error(
          "FLEX_CUSTOMERS가 지정됐지만 outputDir이 해당 법인 디렉토리가 아닙니다.",
          { customers: config.customers, outputDir: resolved.resolvedPath, basename: dirBasename },
        );
        process.exit(1);
      }

      await importOne(resolved.resolvedPath, resolved.resolvedPath, logger);
      return;
    }

    logger.error("임포트할 데이터가 없습니다", { outputDir: config.outputDir });
    process.exit(1);
  }

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
