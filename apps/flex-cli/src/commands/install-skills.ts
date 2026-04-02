import { accessSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runInstallSkills(): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const skillsSource = path.resolve(__dirname, "../../skills");
  const projectRoot = findProjectRoot(process.cwd());
  const skillsTarget = path.join(projectRoot, ".claude", "skills");

  await mkdir(skillsTarget, { recursive: true });

  await cp(skillsSource, skillsTarget, { recursive: true });

  console.log(`[FLEX-AX:INSTALL] 스킬이 ${skillsTarget}에 설치되었습니다`);
  console.log("[FLEX-AX:INSTALL] 설치된 스킬:");
  console.log("  /flex-discover  — API 디스커버리 실행 + 카탈로그 비교");
  console.log("  /flex-crawl     — 크롤링 실행 + 에러 분석/수정");
}

function findProjectRoot(cwd: string): string {
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    // .git 파일 또는 디렉토리가 있으면 프로젝트 루트
    try {
      accessSync(path.join(dir, ".git"));
      return dir;
    } catch {
      // .git 없음 → 상위로
    }
    dir = path.dirname(dir);
  }
  return cwd;
}
