import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { loadConfig } from "../config/index.js";
import { resolveFlexDataDir } from "../paths/index.js";
import path from "node:path";

export async function runFile(): Promise<void> {
  const fileKey = process.argv[3];
  const flag = process.argv[4];

  if (!fileKey) {
    console.error(`Usage: flex-ax file <fileKey> [--info]

파일 키로 파일 내용을 출력합니다.
  --info    메타데이터만 JSON으로 출력`);
    process.exit(1);
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`[FLEX-AX:ERROR] 설정 로딩 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let resolved: ReturnType<typeof resolveFlexDataDir>;
  try {
    resolved = resolveFlexDataDir(config.outputDir);
  } catch (error) {
    console.error(`[FLEX-AX:ERROR] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const dbPath = path.resolve(resolved.resolvedPath, "flex-ax.db");

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.error(`[FLEX-AX:ERROR] DB를 열 수 없습니다: ${dbPath}`);
    process.exit(1);
  }

  try {
    const row = db.prepare(
      "SELECT file_key, file_name, local_path, source, file_size, mime_type FROM files WHERE file_key = ?"
    ).get(fileKey) as { file_key: string; file_name: string; local_path: string | null; source: string; file_size: number | null; mime_type: string | null } | undefined;

    if (!row) {
      console.error(`[FLEX-AX:ERROR] 파일을 찾을 수 없습니다: ${fileKey}`);
      process.exit(1);
    }

    if (flag === "--info") {
      console.log(JSON.stringify(row, null, 2));
      return;
    }

    if (!row.local_path) {
      console.error(`[FLEX-AX:ERROR] 로컬 파일 경로가 없습니다: ${fileKey}`);
      process.exit(1);
    }

    // 바이너리 파일을 stdout으로 출력
    try {
      const stream = createReadStream(row.local_path);
      stream.pipe(process.stdout);
      await new Promise((resolve, reject) => {
        stream.on("end", () => resolve(undefined));
        stream.on("error", reject);
      });
    } catch (error) {
      console.error(`[FLEX-AX:ERROR] 파일 읽기 실패: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } finally {
    db.close();
  }
}
