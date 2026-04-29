import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import semver from "semver";

import {
  downloadAndInstall,
  getCurrentVersion,
  getLatestVersion,
  isStandaloneExecutableRun,
} from "./commands/update.js";

export const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
export const FAILURE_TTL_MS = 30 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 2000;
const REENTRY_GUARD_ENV = "FLEX_AX_AUTO_UPDATE_REENTRY";

export interface CheckCache {
  checkedAt: number;
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

export function isCacheFresh(cache: CheckCache | null, now: number): boolean {
  if (!cache) return false;
  const ttl = cache.latestVersion ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  return now - cache.checkedAt < ttl;
}

export function isOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.FLEX_AX_AUTO_UPDATE;
  return v === "false" || v === "0" || v === "no";
}

export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.CI;
  return v === "true" || v === "1";
}

function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
}

function isInstalledRun(): boolean {
  return isStandaloneExecutableRun();
}

export function compareVersions(a: string, b: string): number {
  const av = semver.valid(a);
  const bv = semver.valid(b);
  if (!av || !bv) return 0;
  return semver.compare(av, bv);
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

  const current = await getCurrentVersion().catch(() => null);
  if (!current) return;

  const now = Date.now();
  const cached = await readCache();

  let latest: string | null = null;
  if (isCacheFresh(cached, now)) {
    latest = cached?.latestVersion ?? null;
  } else {
    latest = await fetchLatestWithTimeout();
    await writeCache(
      latest
        ? { checkedAt: now, latestVersion: latest }
        : { checkedAt: now },
    ).catch(() => {});
  }
  if (!latest) return;

  if (compareVersions(latest, current) <= 0) return;

  if (isCi() || !isInteractive()) {
    console.error(
      `[FLEX-AX] update available ${latest} (current ${current}). Run \`flex-ax update\` to upgrade.`,
    );
    return;
  }

  console.error(`[FLEX-AX] updating ${current} -> ${latest}`);
  console.error("[FLEX-AX] set FLEX_AX_AUTO_UPDATE=false to disable automatic updates");

  try {
    await downloadAndInstall(latest, { relaunchArgs: originalArgs });
  } catch (err) {
    console.error(
      `[FLEX-AX] automatic update failed, continuing with the current version. ${err instanceof Error ? err.message : err}`,
    );
    await writeCache({ checkedAt: Date.now() }).catch(() => {});
  }
}
