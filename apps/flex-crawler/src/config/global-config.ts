import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * flex-cli가 작성한 글로벌 config(`~/.flex-ax/config.json`)에서 이메일을 읽는다.
 * flex-crawler 자체는 config를 작성하지 않는다 — flex-cli의 `login` 명령이 단일
 * 진입점이고, flex-crawler는 그 결과를 그대로 활용한다.
 */
const CONFIG_PATH = join(homedir(), ".flex-ax", "config.json");

export interface GlobalConfig {
  email?: string;
}

export function loadGlobalConfig(): GlobalConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as GlobalConfig;
    }
    return {};
  } catch {
    return {};
  }
}
