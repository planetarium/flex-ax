import { getWorkflowReadUsage, runWorkflowReadCommand } from "./workflow-read.js";

export async function runDocument(argv: string[] = process.argv.slice(3)): Promise<void> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "list":
    case "show":
    case "attachments":
      console.error(`[FLEX-AX:DOCUMENT:WARN] document ${sub}은 deprecated입니다. workflow ${sub}을 사용하세요.`);
      await runWorkflowReadCommand(sub, rest, "DOCUMENT");
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      process.exit(sub === undefined ? 1 : 0);
    default:
      console.error(`[FLEX-AX:DOCUMENT:ERROR] 알 수 없는 서브커맨드: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: flex-ax document <subcommand>

Deprecated workflow aliases:
  list                          deprecated: workflow list 사용
  show <documentKey>            deprecated: workflow show 사용
  attachments <documentKey>     deprecated: workflow attachments 사용

이 명령의 결재 문서 읽기 기능은 workflow로 이동했습니다.
문서·증명서 메뉴용 회사 문서/증명서 명령은 별도 서브커맨드로 추가될 예정입니다.

${getWorkflowReadUsage("workflow")}`);
}
