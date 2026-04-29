import { loadConfig } from "../config/index.js";
import { saveGlobalConfig, getGlobalConfigPath } from "../config/global-config.js";
import { createLogger } from "../logger/index.js";
import { performLogin } from "../auth/index.js";
import { promptLine, promptPassword, saveToKeyring } from "../auth/credentials.js";

/**
 * 이메일 + 비밀번호를 입력받아 실제 5단계 로그인까지 통과하면
 *   - 이메일은 `~/.flex-ax/config.json` (글로벌 config) 에
 *   - 비밀번호는 OS 키링 (service=flex-ax, account=email) 에
 * 저장한다. 검증 없이 저장하면 오타가 그대로 들어가 다음 실행에서 401만 반복된다.
 */
export async function runLogin(): Promise<void> {
  const logger = createLogger("LOGIN");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    logger.error("login은 대화형 터미널에서만 실행할 수 있습니다.");
    process.exit(1);
  }

  // 이메일: env > 글로벌 config > 프롬프트
  let email = config.flexEmail;
  let emailWasPrompted = false;
  if (!email) {
    email = await promptLine("[FLEX-AX:LOGIN] 이메일: ");
    if (!email) {
      logger.error("이메일 입력이 비어있습니다.");
      process.exit(1);
    }
    emailWasPrompted = true;
  }

  const password = await promptPassword(`[FLEX-AX:LOGIN] ${email} 비밀번호: `);
  if (password.length === 0) {
    logger.error("비밀번호 입력이 비어있습니다.");
    process.exit(1);
  }

  try {
    await performLogin(config.flexBaseUrl, email, password, logger);
  } catch (error) {
    logger.error("로그인 검증 실패 — 키링/글로벌 config에 저장하지 않았습니다", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  // 검증 통과 후에만 저장한다.
  if (emailWasPrompted) {
    saveGlobalConfig({ email });
    console.log(`[FLEX-AX:LOGIN] 이메일 저장: ${getGlobalConfigPath()}`);
  }
  saveToKeyring(email, password, logger);
  console.log(`[FLEX-AX:LOGIN] 완료 — 이후 crawl/check-apis 실행 시 자동으로 사용됩니다.`);
}
