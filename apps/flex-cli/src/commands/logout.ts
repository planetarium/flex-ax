import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { deleteLegacyPassword, deleteSession } from "../auth/session.js";
import { confirmGuiLogout, GuiUnavailableError } from "../gui/dialogs.js";

export async function runLogout(argv: string[] = process.argv.slice(3)): Promise<void> {
  const logger = createLogger("LOGOUT");
  const useGui = argv.includes("--gui");

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

  if (useGui) {
    let confirmed = false;
    try {
      confirmed = await confirmGuiLogout(config.flexEmail);
    } catch (error) {
      if (error instanceof GuiUnavailableError) {
        logger.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    if (!confirmed) {
      console.log("[FLEX-AX:LOGOUT] 취소됨 — 로그인 세션을 유지했습니다.");
      return;
    }
  }

  // 비밀번호 로그인 시절 키링 항목도 함께 지운다
  const removedSession = deleteSession(config.flexEmail);
  const removedLegacy = deleteLegacyPassword(config.flexEmail);
  if (removedSession || removedLegacy) {
    console.log(`[FLEX-AX:LOGOUT] 로그인 세션 삭제: ${config.flexEmail}`);
  } else {
    console.log(`[FLEX-AX:LOGOUT] 저장된 로그인 세션 없음: ${config.flexEmail}`);
  }
  // 이메일은 비밀이 아니므로 글로벌 config에 그대로 둔다.
  // 이메일까지 지우려면 사용자가 직접 ~/.flex-ax/config.json 을 삭제하면 된다.
}
