import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface ResolvedFlexDataDir {
  requestedPath: string;
  resolvedPath: string;
}

export function resolveFlexDataDir(inputPath: string): ResolvedFlexDataDir {
  const requestedPath = path.resolve(inputPath);

  if (isExportDir(requestedPath)) {
    return {
      requestedPath,
      resolvedPath: requestedPath,
    };
  }

  const candidates = listExportDirs(path.join(requestedPath, "output"));
  if (candidates.length > 0) {
    throw new Error(buildAmbiguousPathMessage(requestedPath, candidates));
  }

  throw new Error(
    `유효한 export 디렉터리가 아닙니다: ${requestedPath}\n` +
    `예시: OUTPUT_DIR=flex-export/output/<export-id>`,
  );
}

function buildAmbiguousPathMessage(requestedPath: string, candidates: string[]): string {
  const formatted = candidates.map((candidate) => `  - ${candidate}`).join("\n");
  return (
    `export 디렉터리를 명시적으로 지정해 주세요: ${requestedPath}\n` +
    `다음 중 하나를 OUTPUT_DIR로 지정하면 됩니다:\n${formatted}`
  );
}

function listExportDirs(basePath: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(basePath);
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(basePath, entry);
    try {
      if (!statSync(fullPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    if (isExportDir(fullPath)) {
      candidates.push(fullPath);
    }
  }

  return candidates.sort((a, b) => a.localeCompare(b));
}

function isExportDir(dirPath: string): boolean {
  const hasDb = existsSync(path.join(dirPath, "flex-ax.db"));
  const hasReport = existsSync(path.join(dirPath, "crawl-report.json"));
  const hasJsonDirs =
    existsSync(path.join(dirPath, "templates")) ||
    existsSync(path.join(dirPath, "instances")) ||
    existsSync(path.join(dirPath, "attendance"));

  return hasDb || hasReport || hasJsonDirs;
}
