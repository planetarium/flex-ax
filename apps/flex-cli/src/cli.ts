import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const originalArgs = process.argv.slice(2);
const command = originalArgs[0];

if (command === "--version" || command === "-v") {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
  console.log(`flex-ax ${pkg.version}`);
  process.exit(0);
}

await import("dotenv/config");

if (command && command !== "update" && command !== "help") {
  const { maybeAutoUpdate } = await import("./auto-update.js");
  await maybeAutoUpdate(originalArgs);
}

switch (command) {
  case "login": {
    const { runLogin } = await import("./commands/login.js");
    await runLogin();
    break;
  }
  case "logout": {
    const { runLogout } = await import("./commands/logout.js");
    await runLogout();
    break;
  }
  case "crawl": {
    const { runCrawl } = await import("./commands/crawl.js");
    await runCrawl();
    break;
  }
  case "import": {
    const { runImport } = await import("./commands/import.js");
    await runImport();
    break;
  }
  case "query": {
    const { runQuery } = await import("./commands/query.js");
    await runQuery();
    break;
  }
  case "file": {
    const { runFile } = await import("./commands/file.js");
    await runFile();
    break;
  }
  case "check-apis": {
    const { runCheckApis } = await import("./commands/check-apis.js");
    await runCheckApis();
    break;
  }
  case "install-skills": {
    const { runInstallSkills } = await import("./commands/install-skills.js");
    await runInstallSkills();
    break;
  }
  case "update": {
    const { runUpdate } = await import("./commands/update.js");
    await runUpdate();
    break;
  }
  default:
    if (command && command !== "help") {
      console.error(`[FLEX-AX:ERROR] Unknown command: ${command}`);
    }
    console.log(`Usage: flex-ax <command>

Commands:
  login           OS 키링에 비밀번호 저장 (검증 후 저장)
  logout          OS 키링에서 비밀번호 삭제
  crawl           카탈로그 기반 크롤링 → output/ 저장
  import          크롤링 결과(JSON) → SQLite DB 변환
  query "SQL"     DB 쿼리 실행 → JSON 출력 (read-only)
                  --file <path>  SQL 파일 경로
                  --var key=value  {{key}} 플레이스홀더 치환 (반복 가능)
  file <fileKey>  파일 내용 출력 (--info로 메타데이터만)
  check-apis      하드코딩된 API 엔드포인트 상태 확인
  install-skills  에이전트 스킬을 .claude/skills/에 설치
  update          최신 버전으로 업데이트

Options:
  --version, -v   버전 출력

Env:
  FLEX_EMAIL                  필수 — flex 로그인 이메일
  FLEX_PASSWORD               선택 — 지정 시 키링/프롬프트보다 우선
                              (CI에서 사용, 평소엔 \`flex-ax login\` 권장)
  FLEX_BASE_URL               기본 https://flex.team
  FLEX_CUSTOMERS              크롤 대상 법인 customerIdHash (콤마 구분)
  FLEX_AX_AUTO_UPDATE=false   기동 시 자동 업데이트 비활성화`);
    process.exit(command === "help" ? 0 : 1);
}
