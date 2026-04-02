import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { importToSqlite } from "../db/import.js";
import path from "node:path";

export async function runImport(): Promise<void> {
  const logger = createLogger("IMPORT");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const dbPath = path.resolve(config.outputDir, "flex-ax.db");
  logger.info(`${config.outputDir}/ → ${dbPath}`);

  const result = await importToSqlite(config.outputDir, dbPath, logger);

  console.log(`[FLEX-AX:IMPORT] 임포트 완료: ${dbPath}`);
  console.log(`[FLEX-AX:IMPORT] templates=${result.templates}, instances=${result.instances}, attendance=${result.attendance}`);
  console.log(`[FLEX-AX:IMPORT] users=${result.users}, fields=${result.fieldValues}, approvals=${result.approvalLines}, comments=${result.comments}, attachments=${result.attachments}`);
}
