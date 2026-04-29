import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 사용자별 글로벌 설정 파일.
 *
 * - 위치: `~/.flex-ax/config.json` (Win/macOS/Linux 공통 — `os.homedir()` 기준)
 * - 권한: 0600 — 본인만 읽기/쓰기. 이메일은 비밀이 아니지만 위생상 좁힌다.
 * - 용도: CWD 의 `.env` 와 무관하게 어디서든 `flex-ax`/`flex-crawler` 가
 *   자기 자신의 정보를 찾을 수 있도록 한다. 비밀번호는 여기에 저장하지 않고
 *   OS 키링으로 분리한다 (auth/credentials.ts).
 */
const CONFIG_DIR = join(homedir(), ".flex-ax");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface GlobalConfig {
  email?: string;
}

export function getGlobalConfigPath(): string {
  return CONFIG_PATH;
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
    // 파일 깨졌거나 권한 문제 — 호출자가 빈 값으로 폴백 처리
    return {};
  }
}

export function saveGlobalConfig(update: Partial<GlobalConfig>): void {
  const existing = loadGlobalConfig();
  const merged: GlobalConfig = { ...existing, ...update };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
}
