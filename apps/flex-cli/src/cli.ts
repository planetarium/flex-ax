import "dotenv/config";

const command = process.argv[2];

switch (command) {
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
  default:
    if (command && command !== "help") {
      console.error(`[FLEX-AX:ERROR] Unknown command: ${command}`);
    }
    console.log(`Usage: flex-ax <command>

Commands:
  crawl           카탈로그 기반 크롤링 → output/ 저장
  install-skills  에이전트 스킬을 .claude/skills/에 설치`);
    process.exit(command === "help" ? 0 : 1);
}
