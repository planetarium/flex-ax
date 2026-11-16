import { loadConfig } from "../config/index.js";
import { getGlobalConfigPath, loadGlobalConfig } from "../config/global-config.js";
import { getSessionFilePath, loadSession } from "../auth/session.js";

/**
 * 현재 등록된 자격을 안전하게 요약한다 — 토큰 값은 노출하지 않고 세션 유무·만료만.
 * 에이전트나 사용자가 "내 키링/글로벌 config 어떻게 돼있지?" 를 빠르게 확인하기 위함.
 */
export async function runStatus(): Promise<void> {
  const config = loadConfig();
  const global = loadGlobalConfig();

  const emailSource = process.env.FLEX_EMAIL
    ? "env(FLEX_EMAIL)"
    : global.email
      ? "global config"
      : "(없음)";

  const stored = config.flexEmail ? loadSession(config.flexEmail) : null;
  let sessionStatus = "(없음) — flex-ax login 필요";
  let sessionSource = "—";
  if (stored) {
    const expired = Date.parse(stored.session.refreshExpireAt) < Date.now();
    sessionStatus = `${expired ? "만료" : "유효"} (만료 ${stored.session.refreshExpireAt})`;
    sessionSource = stored.source === "keyring" ? "OS 키링" : getSessionFilePath();
  }

  console.log(`[FLEX-AX:STATUS]`);
  console.log(`  email             : ${config.flexEmail || "(없음)"}`);
  console.log(`  email source      : ${emailSource}`);
  console.log(`  session           : ${sessionStatus}`);
  console.log(`  session source    : ${sessionSource}`);
  console.log(`  global config     : ${getGlobalConfigPath()}`);
  console.log(`  base url          : ${config.flexBaseUrl}`);
}
