import { FLEX_AX_VERSION } from "./version.js";
import { getCommandHelp, getTopLevelHelp, isHelpFlag } from "./cli-help.js";

const originalArgs = process.argv.slice(2);
const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const wantsTopLevelHelp = !command || command === "help" || isHelpFlag(command);
const wantsCommandHelp = !wantsTopLevelHelp && rawArgs.slice(1).some((arg) => isHelpFlag(arg));

if (command === "--version" || command === "-v") {
  console.log(`flex-ax ${FLEX_AX_VERSION}`);
  process.exit(0);
}

if (wantsTopLevelHelp) {
  if (command === "help" && rawArgs[1]) {
    const commandHelp = getCommandHelp(rawArgs[1]);
    if (commandHelp) {
      console.log(commandHelp);
      process.exit(0);
    }
  }
  console.log(getTopLevelHelp());
  process.exit(0);
}

if (wantsCommandHelp) {
  const commandHelp = getCommandHelp(command);
  if (commandHelp) {
    console.log(commandHelp);
    process.exit(0);
  }
}

await import("dotenv/config");

if (command && command !== "update" && command !== "help" && command !== "__self-update-helper") {
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
  case "status": {
    const { runStatus } = await import("./commands/status.js");
    await runStatus();
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
  case "attendance": {
    const { runAttendance } = await import("./commands/attendance.js");
    await runAttendance();
    break;
  }
  case "document": {
    const { runDocument } = await import("./commands/document.js");
    await runDocument();
    break;
  }
  case "people": {
    const { runPeople } = await import("./commands/people.js");
    await runPeople();
    break;
  }
  case "file": {
    const { runFile } = await import("./commands/file.js");
    await runFile();
    break;
  }
  case "workflow": {
    const { runWorkflow } = await import("./commands/workflow.js");
    await runWorkflow();
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
  case "__self-update-helper": {
    const { runSelfUpdateHelper } = await import("./commands/update.js");
    await runSelfUpdateHelper();
    break;
  }
  default:
    console.error(`[FLEX-AX:ERROR] Unknown command: ${command}`);
    console.log(getTopLevelHelp());
    process.exit(1);
}
