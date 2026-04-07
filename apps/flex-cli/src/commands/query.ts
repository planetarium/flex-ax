import Database from "better-sqlite3";
import { loadConfig } from "../config/index.js";
import path from "node:path";
import { readFileSync } from "node:fs";

export class QueryArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryArgError";
  }
}

export function parseQueryArgs(argv: string[]): {
  sql: string | null;
  filePath: string | null;
  vars: Map<string, string>;
} {
  const args = argv.slice(3);
  let filePath: string | null = null;
  const vars = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new QueryArgError("--file에 파일 경로를 지정해 주세요.");
      }
      filePath = args[++i];
    } else if (args[i] === "--var") {
      if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
        throw new QueryArgError("--var에 key=value 값을 지정해 주세요.");
      }
      const varArg = args[++i];
      const eqIdx = varArg.indexOf("=");
      if (eqIdx === -1) {
        throw new QueryArgError(`--var 형식이 잘못되었습니다: ${varArg} (expected key=value)`);
      }
      vars.set(varArg.slice(0, eqIdx), varArg.slice(eqIdx + 1));
    } else {
      positional.push(args[i]);
    }
  }

  const inlineSQL = positional.join(" ").trim() || null;
  return { sql: inlineSQL, filePath, vars };
}

export function applyVars(sql: string, vars: Map<string, string>): string {
  let result = sql;
  for (const [key, value] of vars) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export async function runQuery(): Promise<void> {
  let parsed: ReturnType<typeof parseQueryArgs>;
  try {
    parsed = parseQueryArgs(process.argv);
  } catch (error) {
    if (error instanceof QueryArgError) {
      console.error(`[FLEX-AX:ERROR] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const { sql: inlineSQL, filePath, vars } = parsed;

  let sql: string;
  if (filePath) {
    try {
      sql = readFileSync(filePath, "utf-8").trim();
    } catch (error) {
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? ` [${(error as { code: string }).code}]`
          : "";
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[FLEX-AX:ERROR] SQL 파일을 읽을 수 없습니다: ${filePath}${errorCode} - ${errorMessage}`,
      );
      process.exit(1);
    }
    if (!sql) {
      console.error(`[FLEX-AX:ERROR] SQL 파일이 비어 있습니다: ${filePath}`);
      process.exit(1);
    }
    if (inlineSQL) {
      console.error(`[FLEX-AX:ERROR] --file과 인라인 SQL을 동시에 사용할 수 없습니다.`);
      process.exit(1);
    }
  } else if (inlineSQL) {
    sql = inlineSQL;
  } else {
    console.error(`Usage: flex-ax query "SELECT ..."
       flex-ax query --file queries/search.sql [--var key=value ...]

SQL을 실행하고 결과를 JSON으로 출력합니다 (read-only).
스키마는 apps/flex-cli/src/db/schema.sql 을 참조하세요.`);
    process.exit(1);
  }

  if (vars.size > 0) {
    sql = applyVars(sql, vars);
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[FLEX-AX:ERROR] 설정 로딩 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const dbPath = path.resolve(config.outputDir, "flex-ax.db");

  let db: InstanceType<typeof Database>;
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
