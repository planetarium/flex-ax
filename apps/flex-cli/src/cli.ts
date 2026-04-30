#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { FLEX_AX_VERSION } from "./version.js";
import { getCommandHelp } from "./cli-help.js";

const originalArgs = process.argv.slice(2);

const program = new Command();

program
  .name("flex-ax")
  .description("flex HR SaaS AX CLI - discover, crawl, and manage flex data")
  .version(FLEX_AX_VERSION, "-v, --version", "버전 출력")
  .enablePositionalOptions()
  .showHelpAfterError();

program.addHelpText(
  "after",
  `
Workflow:
  login -> status -> crawl -> import -> query

Multi-export query:
  OUTPUT_DIR=<export-dir> flex-ax query "SELECT 1 AS x"
  export 디렉터리가 여러 개면 OUTPUT_DIR로 사용할 대상 하나를 명시해야 합니다.

Env:
  FLEX_EMAIL
  FLEX_PASSWORD
  FLEX_BASE_URL
  FLEX_CUSTOMERS
  FLEX_AX_AUTO_UPDATE=false
`,
);

function describe(commandName: string, fallback: string): string {
  return getCommandHelp(commandName) ?? fallback;
}

function addPassthroughCommand(
  parent: Command,
  name: string,
  summary: string,
  runner: (args: string[]) => Promise<void>,
): void {
  parent
    .command(`${name} [args...]`)
    .summary(summary)
    .description(describe(name, summary))
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (args: string[] = []) => {
      await runDelegatedCommand(name, args, runner);
    });
}

async function runDelegatedCommand(
  commandName: string,
  args: string[],
  runner: (args: string[]) => Promise<void>,
): Promise<void> {
  if (
    commandName !== "update" &&
    commandName !== "help" &&
    commandName !== "__self-update-helper"
  ) {
    const { maybeAutoUpdate } = await import("./auto-update.js");
    await maybeAutoUpdate(originalArgs);
  }

  await runner(args);
}

addPassthroughCommand(program, "login", "이메일/비밀번호 등록", async (args) => {
  const { runLogin } = await import("./commands/login.js");
  await runLogin(args);
});

addPassthroughCommand(program, "logout", "OS 키링에서 비밀번호 삭제", async () => {
  const { runLogout } = await import("./commands/logout.js");
  await runLogout();
});

addPassthroughCommand(program, "status", "현재 등록 상태 표시", async () => {
  const { runStatus } = await import("./commands/status.js");
  await runStatus();
});

addPassthroughCommand(program, "crawl", "카탈로그 기반 크롤링", async () => {
  const { runCrawl } = await import("./commands/crawl.js");
  await runCrawl();
});

addPassthroughCommand(program, "import", "크롤링 결과를 SQLite로 변환", async () => {
  const { runImport } = await import("./commands/import.js");
  await runImport();
});

addPassthroughCommand(program, "query", "DB 쿼리 실행", async (args) => {
  const { runQuery } = await import("./commands/query.js");
  await runQuery(args);
});

const live = program
  .command("live")
  .summary("flex.team 라이브 조회 진입점")
  .description(describe("live", "flex.team 라이브 조회 명령의 공통 진입점입니다."))
  .enablePositionalOptions()
  .showHelpAfterError();

addPassthroughCommand(live, "attendance", "휴가/근태 라이브 조회", async (args) => {
  const { runAttendance } = await import("./commands/attendance.js");
  await runAttendance(args);
});

addPassthroughCommand(live, "document", "문서 명령(legacy 결재 문서 조회)", async (args) => {
  const { runDocument } = await import("./commands/document.js");
  await runDocument(args);
});

addPassthroughCommand(live, "people", "구성원/부서 라이브 조회", async (args) => {
  const { runPeople } = await import("./commands/people.js");
  await runPeople(args);
});

addPassthroughCommand(live, "workflow", "결재 문서 워크플로 라이브 실행", async (args) => {
  const { runWorkflow } = await import("./commands/workflow.js");
  await runWorkflow(args);
});

addPassthroughCommand(program, "attendance", "내 휴가/근태 사용 내역 라이브 조회", async (args) => {
  const { runAttendance } = await import("./commands/attendance.js");
  await runAttendance(args);
});

addPassthroughCommand(program, "document", "문서 명령(legacy 결재 문서 조회)", async (args) => {
  const { runDocument } = await import("./commands/document.js");
  await runDocument(args);
});

addPassthroughCommand(program, "people", "구성원/부서 라이브 조회", async (args) => {
  const { runPeople } = await import("./commands/people.js");
  await runPeople(args);
});

addPassthroughCommand(program, "file", "파일 내용 출력", async (args) => {
  const { runFile } = await import("./commands/file.js");
  await runFile(args);
});

addPassthroughCommand(program, "workflow", "결재 문서 작성/제출", async (args) => {
  const { runWorkflow } = await import("./commands/workflow.js");
  await runWorkflow(args);
});

addPassthroughCommand(program, "check-apis", "하드코딩된 API 엔드포인트 상태 확인", async () => {
  const { runCheckApis } = await import("./commands/check-apis.js");
  await runCheckApis();
});

addPassthroughCommand(program, "install-skills", "에이전트 스킬 설치", async () => {
  const { runInstallSkills } = await import("./commands/install-skills.js");
  await runInstallSkills();
});

addPassthroughCommand(program, "update", "최신 버전으로 업데이트", async () => {
  const { runUpdate } = await import("./commands/update.js");
  await runUpdate();
});

addPassthroughCommand(program, "__self-update-helper", "internal", async (args) => {
  const { runSelfUpdateHelper } = await import("./commands/update.js");
  await runSelfUpdateHelper(args);
});

await program.parseAsync(process.argv);
