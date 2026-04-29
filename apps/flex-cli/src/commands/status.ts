import { loadConfig } from "../config/index.js";
import { getGlobalConfigPath, loadGlobalConfig } from "../config/global-config.js";
import { readFromKeyring } from "../auth/credentials.js";

/**
 * 현재 등록된 자격을 안전하게 요약한다 — 비밀번호 값은 노출하지 않고 등록 여부만.
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

  let passwordStatus: string;
  let passwordSource: string;
  if (process.env.FLEX_PASSWORD) {
    passwordStatus = "set";
    passwordSource = "env(FLEX_PASSWORD)";
  } else if (config.flexEmail && readFromKeyring(config.flexEmail) !== null) {
    passwordStatus = "set";
    passwordSource = "OS 키링";
  } else {
    passwordStatus = "(없음)";
    passwordSource = "—";
  }

  console.log(`[FLEX-AX:STATUS]`);
  console.log(`  email             : ${config.flexEmail || "(없음)"}`);
  console.log(`  email source      : ${emailSource}`);
  console.log(`  password          : ${passwordStatus}`);
  console.log(`  password source   : ${passwordSource}`);
  console.log(`  global config     : ${getGlobalConfigPath()}`);
  console.log(`  base url          : ${config.flexBaseUrl}`);
}
