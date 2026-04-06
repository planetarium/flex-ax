import "dotenv/config";

// --auth <mode> 플래그 파싱 (커맨드 앞뒤 어디든 가능)
const rawArgs = process.argv.slice(2);
const authIdx = rawArgs.indexOf("--auth");
if (authIdx !== -1) {
  const authValue = rawArgs[authIdx + 1];
  if (!authValue || authValue.startsWith("-")) {
    console.error(`[FLEX-AX:ERROR] --auth에 모드를 지정해 주세요: credentials | sso | playwriter`);
    process.exit(1);
  }
  process.env.AUTH_MODE = authValue;
  rawArgs.splice(authIdx, 2);
}
// 정리된 인자를 process.argv에 반영 (하위 커맨드가 참조할 수 있도록)
process.argv = [process.argv[0], process.argv[1], ...rawArgs];

const command = rawArgs[0];

switch (command) {
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
  case "install-skills": {
    const { runInstallSkills } = await import("./commands/install-skills.js");
    await runInstallSkills();
    break;
  }
  default:
    if (command && command !== "help") {
      console.error(`[FLEX-AX:ERROR] Unknown command: ${command}`);
    }
    console.log(`Usage: flex-ax <command>

Commands:
  crawl           카탈로그 기반 크롤링 → output/ 저장
  import          크롤링 결과(JSON) → SQLite DB 변환
  query "SQL"     DB 쿼리 실행 → JSON 출력 (read-only)
  file <fileKey>  파일 내용 출력 (--info로 메타데이터만)
  install-skills  에이전트 스킬을 .claude/skills/에 설치

Options:
  --auth <mode>   인증 모드: credentials | sso | playwriter`);
    process.exit(command === "help" ? 0 : 1);
}
