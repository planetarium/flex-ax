import Database from "better-sqlite3";
import { loadConfig } from "../config/index.js";
import path from "node:path";

export async function runQuery(): Promise<void> {
  const sql = process.argv.slice(3).join(" ").trim();

  if (!sql) {
    console.error(`Usage: flex-ax query "SELECT ..."

SQL을 실행하고 결과를 JSON으로 출력합니다 (read-only).
스키마는 apps/flex-cli/src/db/schema.sql 을 참조하세요.`);
    process.exit(1);
  }

  const config = loadConfig();
  const dbPath = path.resolve(config.outputDir, "flex-ax.db");

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error(`[FLEX-AX:ERROR] DB를 열 수 없습니다: ${dbPath}`);
    console.error(`flex-ax import 를 먼저 실행하세요.`);
    process.exit(1);
  }

  try {
    const rows = db.prepare(sql).all();
    console.log(JSON.stringify(rows, null, 2));
  } catch (error) {
    console.error(`[FLEX-AX:ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
