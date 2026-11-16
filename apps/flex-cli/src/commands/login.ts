import { loadConfig } from "../config/index.js";
import { saveGlobalConfig, getGlobalConfigPath, loadGlobalConfig } from "../config/global-config.js";
import { createLogger } from "../logger/index.js";
import { requestEmailCode, toStoredSession, verifyEmailCode } from "../auth/index.js";
import { promptLine } from "../auth/credentials.js";
import {
  deleteLegacyPassword,
  deletePending,
  getSessionFilePath,
  loadPending,
  savePending,
  saveSession,
  withSessionLock,
} from "../auth/session.js";
import { GuiUnavailableError, promptGuiCode, promptGuiEmail } from "../gui/dialogs.js";

type Logger = ReturnType<typeof createLogger>;

/**
 * 이메일 인증 코드로 로그인해 refresh token을 저장한다 (flex는 2026-11-11부터 비밀번호 로그인 폐지).
 *   - 이메일은 `~/.flex-ax/config.json`
 *   - 세션(refresh token)은 OS 키링 또는 세션 파일 (auth/session.ts)
 *
 * 비대화식 흐름(에이전트/서버) — 두 단계로 나눈다:
 *   1) `flex-ax login --request-code` : 코드 메일 발송, 로그인 세션을 pending-login.json 에 보관
 *   2) `flex-ax login --code <코드>`   : 받은 코드로 로그인 완료
 * 코드는 5분 안에 한 번만 쓸 수 있어 명령행 인자로 받아도 재사용 위험이 없다.
 */
export async function runLogin(argv: string[] = process.argv.slice(3)): Promise<void> {
  const logger = createLogger("LOGIN");
  const useGui = argv.includes("--gui");
  const requestOnly = argv.includes("--request-code");
  const codeIdx = argv.indexOf("--code");
  const codeArg = codeIdx >= 0 ? argv[codeIdx + 1] : undefined;
  if (codeIdx >= 0 && (!codeArg || codeArg.startsWith("--"))) {
    logger.error("--code 뒤에 메일로 받은 인증 코드를 적어 주세요.");
    process.exit(1);
  }
  if ([useGui, requestOnly, codeArg !== undefined].filter(Boolean).length > 1) {
    logger.error("--gui, --request-code, --code 는 함께 사용할 수 없습니다.");
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (codeArg !== undefined) {
    await completePendingLogin(codeArg, logger);
    return;
  }

  // 이메일 — env > 글로벌 config > (GUI 대화상자 | TTY 프롬프트) > 에러
  let email = config.flexEmail;
  if (useGui) {
    try {
      email = (await promptGuiEmail(email)).trim();
    } catch (error) {
      exitOnGuiError(error, logger);
    }
  } else if (!email) {
    if (requestOnly || process.stdin.isTTY !== true) {
      logger.error(
        "이메일을 찾을 수 없습니다 — 비대화식 환경에서는 FLEX_EMAIL env 또는 ~/.flex-ax/config.json 의 email이 필요합니다.",
      );
      process.exit(1);
    }
    email = await promptLine("[FLEX-AX:LOGIN] 이메일: ");
  }
  if (!email) {
    logger.error("이메일 입력이 비어있습니다.");
    process.exit(1);
  }

  let pending;
  try {
    pending = await requestEmailCode(config.flexBaseUrl, email, logger);
  } catch (error) {
    logger.error("인증 코드 요청 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (requestOnly) {
    savePending(pending);
    console.log(`[FLEX-AX:LOGIN] 메일로 받은 코드로 \`flex-ax login --code <코드>\` 를 실행하세요 (만료 ${pending.codeExpiresAt}).`);
    return;
  }

  let code = "";
  if (useGui) {
    try {
      code = await promptGuiCode(email);
    } catch (error) {
      exitOnGuiError(error, logger);
    }
  } else if (process.stdin.isTTY === true) {
    code = await promptLine(`[FLEX-AX:LOGIN] ${email} 로 받은 인증 코드: `);
  } else {
    logger.error("TTY가 아니라 코드를 입력받을 수 없습니다 — `--request-code` 와 `--code` 를 사용하세요.");
    process.exit(1);
  }
  if (!code.trim()) {
    logger.error("인증 코드 입력이 비어있습니다.");
    process.exit(1);
  }

  await finishLogin(pending, code, logger);
}

async function completePendingLogin(code: string, logger: Logger): Promise<void> {
  const pending = loadPending();
  if (!pending) {
    logger.error("대기 중인 로그인이 없습니다 — 먼저 `flex-ax login --request-code` 를 실행하세요.");
    process.exit(1);
  }
  if (Date.parse(pending.codeExpiresAt) < Date.now()) {
    deletePending();
    logger.error("인증 코드가 만료됐습니다 — `flex-ax login --request-code` 부터 다시 하세요.");
    process.exit(1);
  }
  await finishLogin(pending, code, logger);
  deletePending();
}

async function finishLogin(
  pending: Parameters<typeof verifyEmailCode>[0],
  code: string,
  logger: Logger,
): Promise<void> {
  let result;
  try {
    result = await verifyEmailCode(pending, code, logger);
  } catch (error) {
    logger.error("로그인 실패 — 세션을 저장하지 않았습니다", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (loadGlobalConfig().email !== pending.email) {
    saveGlobalConfig({ email: pending.email });
    console.log(`[FLEX-AX:LOGIN] 이메일 저장: ${getGlobalConfigPath()}`);
  }
  // 갱신과 같은 잠금 안에서 — 만료 세션을 갱신하다 거절당한 다른 실행이 방금 저장한 새 세션을 지우지 않게
  const loginResult = result;
  await withSessionLock(async () => saveSession(pending.email, toStoredSession(loginResult), logger));
  // 비밀번호 로그인 시절 키링에 남긴 비밀번호는 더 쓰지 않는다
  deleteLegacyPassword(pending.email);
  const where = process.env.FLEX_SESSION_FILE ? getSessionFilePath() : "OS 키링(불가 시 세션 파일)";
  console.log(
    `[FLEX-AX:LOGIN] 완료 — 세션 저장: ${where}, 만료 ${result.refreshExpireAt} (실행할 때마다 7일 연장)`,
  );
}

function exitOnGuiError(error: unknown, logger: Logger): never {
  if (error instanceof GuiUnavailableError) {
    logger.error(error.message);
    process.exit(1);
  }
  throw error;
}
