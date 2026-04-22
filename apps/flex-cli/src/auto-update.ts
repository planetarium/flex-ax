import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  downloadAndInstall,
  getCurrentVersion,
  getLatestVersion,
} from "./commands/update.js";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 2000;
const REENTRY_GUARD_ENV = "FLEX_AX_AUTO_UPDATE_REENTRY";

interface CheckCache {
  lastCheckedAt: number;
  latestVersion?: string;
}

function getCachePath(): string {
  return path.join(os.homedir(), ".flex-ax", "update-check.json");
}

async function readCache(): Promise<CheckCache | null> {
  try {
    const content = await readFile(getCachePath(), "utf-8");
    return JSON.parse(content) as CheckCache;
  } catch {
    return null;
  }
}

async function writeCache(cache: CheckCache): Promise<void> {
  const cachePath = getCachePath();
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2));
}

function isOptedOut(): boolean {
  const v = process.env.FLEX_AX_AUTO_UPDATE;
  return v === "false" || v === "0" || v === "no";
}

function isCi(): boolean {
  const v = process.env.CI;
  return v === "true" || v === "1";
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
}

function isInstalledRun(): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && entry.endsWith("dist/cli.js");
}

async function fetchLatestWithTimeout(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await getLatestVersion(controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function maybeAutoUpdate(originalArgs: string[]): Promise<void> {
  if (isOptedOut()) return;
  if (process.env[REENTRY_GUARD_ENV] === "1") return;
  if (!isInstalledRun()) return;

  const cache = await readCache();
  const now = Date.now();
  if (cache && now - cache.lastCheckedAt < CHECK_INTERVAL_MS) return;

  const current = await getCurrentVersion().catch(() => null);
  if (!current) return;

  const latest = await fetchLatestWithTimeout();
  if (!latest) return;

  await writeCache({ lastCheckedAt: now, latestVersion: latest }).catch(() => {});

  if (current === latest) return;

  if (isCi() || !isInteractive()) {
    console.error(
      `[FLEX-AX] 새 버전 ${latest} 사용 가능 (현재 ${current}). \`flex-ax update\` 로 업데이트하세요.`,
    );
    return;
  }

  console.error(
    `[FLEX-AX] 새 버전 감지: ${current} → ${latest}, 자동 업데이트 후 재실행합니다.`,
  );
  console.error(
    `[FLEX-AX] 자동 업데이트를 끄려면 FLEX_AX_AUTO_UPDATE=false 환경변수를 설정하세요.`,
  );

  try {
    await downloadAndInstall(latest);
  } catch (err) {
    console.error(
      `[FLEX-AX] 자동 업데이트 실패, 기존 버전으로 진행합니다: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  const result = spawnSync(process.execPath, [process.argv[1]!, ...originalArgs], {
    stdio: "inherit",
    env: { ...process.env, [REENTRY_GUARD_ENV]: "1" },
  });
  process.exit(result.status ?? 0);
}
