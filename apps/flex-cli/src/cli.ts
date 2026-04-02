import "dotenv/config";

const command = process.argv[2];

switch (command) {
  case "discover": {
    const { runDiscover } = await import("./commands/discover.js");
    await runDiscover();
    break;
  }
  case "crawl": {
    const { runCrawl } = await import("./commands/crawl.js");
    await runCrawl();
    break;
  }
  case "install-skills": {
    const { runInstallSkills } = await import("./commands/install-skills.js");
    await runInstallSkills();
    break;
  }
  case "check-apis": {
    const { runCheckApis } = await import("./commands/check-apis.js");
    await runCheckApis();
    break;
  }
  default:
    if (command && command !== "help") {
      console.error(`[FLEX-AX:ERROR] Unknown command: ${command}`);
    }
    console.log(`Usage: flex-ax <command>

Commands:
  discover        API 디스커버리 → api-catalog.json 생성
  crawl           카탈로그 기반 크롤링 → output/ 저장
  check-apis      하드코딩된 API 엔드포인트 상태 확인
  install-skills  에이전트 스킬을 .claude/skills/에 설치`);
    process.exit(command === "help" ? 0 : 1);
}
