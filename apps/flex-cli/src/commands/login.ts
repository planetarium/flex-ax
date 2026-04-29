import { loadConfig } from "../config/index.js";
import { saveGlobalConfig, getGlobalConfigPath } from "../config/global-config.js";
import { createLogger } from "../logger/index.js";
import { performLogin } from "../auth/index.js";
import { promptLine, promptPassword, saveToKeyring } from "../auth/credentials.js";

/**
 * 이메일 + 비밀번호를 받아 실제 5단계 로그인까지 통과하면
 *   - 이메일은 `~/.flex-ax/config.json`
 *   - 비밀번호는 OS 키링 (service=flex-ax, account=email)
 * 에 저장한다.
 *
 * 비대화식 흐름(에이전트/CI):
 *   - FLEX_EMAIL/FLEX_PASSWORD env에 둘 다 있으면 프롬프트 없이 바로 진행
 *   - `--password-stdin` 플래그로 비밀번호를 stdin 파이프로 주입 가능
 *   - 비밀번호는 명시적 명령행 인자(`--password XXX`)로는 받지 않는다 — shell history/ps 노출 방지
 */
export async function runLogin(): Promise<void> {
  const logger = createLogger("LOGIN");
  // cli.ts에서 process.argv = [node, cli.js, "login", ...rest]
  const args = process.argv.slice(3);
  const passwordFromStdin = args.includes("--password-stdin");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const isTTY = process.stdin.isTTY === true;

  if (passwordFromStdin && isTTY) {
    logger.error("--password-stdin은 stdin이 파이프로 주입될 때 사용하세요. 대화형 셸이라면 옵션을 빼거나 echo/here-doc으로 파이프하세요.");
    process.exit(1);
  }

  // 1) 이메일 — env > 글로벌 config > 프롬프트(TTY) > 에러
  let email = config.flexEmail;
  let emailWasPrompted = false;
  if (!email) {
    if (!isTTY) {
      logger.error(
        "이메일을 찾을 수 없습니다 — 비대화식 환경에서는 FLEX_EMAIL env 또는 ~/.flex-ax/config.json 의 email이 필요합니다.",
      );
      process.exit(1);
    }
    email = await promptLine("[FLEX-AX:LOGIN] 이메일: ");
    if (!email) {
      logger.error("이메일 입력이 비어있습니다.");
      process.exit(1);
    }
    emailWasPrompted = true;
  }

  // 2) 비밀번호 — env > stdin(--password-stdin) > 프롬프트(TTY) > 에러
  let password: string | null = null;
  if (config.flexPassword) {
    password = config.flexPassword;
  } else if (passwordFromStdin) {
    password = (await readAllStdin()).replace(/\r?\n$/, "");
    if (!password) {
      logger.error("--password-stdin으로 빈 입력이 들어왔습니다.");
      process.exit(1);
    }
  } else if (isTTY) {
    password = await promptPassword(`[FLEX-AX:LOGIN] ${email} 비밀번호: `);
    if (!password) {
      logger.error("비밀번호 입력이 비어있습니다.");
      process.exit(1);
    }
  } else {
    logger.error(
      "비밀번호를 찾을 수 없습니다 — 비대화식 환경에서는 FLEX_PASSWORD env 또는 `--password-stdin` 으로 주입하세요.",
    );
    process.exit(1);
  }

  // 3) 검증 — 실제 로그인 통과해야만 저장
  try {
    await performLogin(config.flexBaseUrl, email, password, logger);
  } catch (error) {
    logger.error("로그인 검증 실패 — 키링/글로벌 config에 저장하지 않았습니다", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (emailWasPrompted) {
    saveGlobalConfig({ email });
    console.log(`[FLEX-AX:LOGIN] 이메일 저장: ${getGlobalConfigPath()}`);
  }
  saveToKeyring(email, password, logger);
  console.log(`[FLEX-AX:LOGIN] 완료 — 이후 crawl/check-apis 실행 시 자동으로 사용됩니다.`);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
