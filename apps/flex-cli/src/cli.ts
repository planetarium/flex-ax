import "dotenv/config";

const command = process.argv[2];

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
  install-skills  에이전트 스킬을 .claude/skills/에 설치`);
    process.exit(command === "help" ? 0 : 1);
}
