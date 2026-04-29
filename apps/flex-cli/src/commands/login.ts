import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { performLogin } from "../auth/index.js";
import { promptPassword, saveToKeyring } from "../auth/credentials.js";

/**
 * 비밀번호를 입력받아 실제 로그인까지 통과하면 OS 키링에 저장한다.
 * 검증 없이 저장하면 오타가 그대로 들어가 다음 실행에서 401만 반복될 수 있다.
 */
export async function runLogin(): Promise<void> {
  const logger = createLogger("LOGIN");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패 — FLEX_EMAIL이 필요합니다", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (!process.stdin.isTTY) {
    logger.error("login은 대화형 터미널에서만 실행할 수 있습니다.");
    process.exit(1);
  }

  const password = await promptPassword(`[FLEX-AX:LOGIN] ${config.flexEmail} 비밀번호: `);
  if (password.length === 0) {
    logger.error("비밀번호 입력이 비어있습니다.");
    process.exit(1);
  }

  // 검증: 실제 5단계 로그인을 수행해 비밀번호가 유효한지 확인
  try {
    await performLogin(config.flexBaseUrl, config.flexEmail, password, logger);
  } catch (error) {
    logger.error("로그인 검증 실패 — 키링에 저장하지 않았습니다", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  saveToKeyring(config.flexEmail, password, logger);
  console.log(`[FLEX-AX:LOGIN] 완료 — 이후 crawl/check-apis 실행 시 자동으로 사용됩니다.`);
}
