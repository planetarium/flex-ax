import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { deleteFromKeyring } from "../auth/credentials.js";

export async function runLogout(): Promise<void> {
  const logger = createLogger("LOGOUT");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패 — FLEX_EMAIL이 필요합니다", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  if (!config.flexEmail) {
    console.log("[FLEX-AX:LOGOUT] 등록된 이메일이 없습니다 — 삭제할 항목이 없습니다.");
    return;
  }

  const removed = deleteFromKeyring(config.flexEmail);
  if (removed) {
    console.log(`[FLEX-AX:LOGOUT] OS 키링 항목 삭제: account=${config.flexEmail}`);
  } else {
    console.log(`[FLEX-AX:LOGOUT] 키링에 저장된 항목 없음: account=${config.flexEmail}`);
  }
  // 이메일은 비밀이 아니므로 글로벌 config에 그대로 둔다.
  // 이메일까지 지우려면 사용자가 직접 ~/.flex-ax/config.json 을 삭제하면 된다.
}
