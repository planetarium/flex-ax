import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { getCurrentVersion, getLatestVersion } from "./commands/update.js";

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
  // npm/pnpm bin shim과 symlink는 process.argv[1]를 .../.bin/flex-ax 같이
  // 만들어 dist/cli.js와 매칭되지 않는 경우가 있다. 이 모듈 자체의 위치를
  // 보면 빌드된 dist에서 import된 경로(또는 tsx의 src/.ts)가 그대로 드러나므로
  // 설치 실행과 dev 실행을 안정적으로 구분할 수 있다.
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(path.join("dist", "auto-update.js"));
}

export function compareVersions(a: string, b: string): number {
  // SemVer §11 (numeric prerelease ordering, dot-separated identifiers 등)을
  // 직접 구현하면 rc10/rc2, alpha.1 같은 케이스를 놓치기 쉬워 검증된
  // semver 패키지에 위임한다. 둘 중 하나라도 invalid면 자동 업데이트를
  // 건너뛰는 게 안전하므로 0(동등)으로 떨어진다.
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
    // 성공 시 SUCCESS_TTL, 실패 시 FAILURE_TTL짜리 캐시를 남겨
    // 네트워크 장애가 지속될 때 매 실행마다 2초 대기를 막는다.
    await writeCache(
      latest
        ? { checkedAt: now, latestVersion: latest }
        : { checkedAt: now },
    ).catch(() => {});
  }
  if (!latest) return;

  // 로컬 빌드/프리릴리스로 current가 더 높을 수 있으므로 다운그레이드는 skip.
  if (compareVersions(latest, current) <= 0) return;

  // flex-ax는 다음 릴리스부터 bun compile 기반 standalone 바이너리로 배포
  // 방식을 전환한다. npm pack tarball을 덮어쓰는 기존 자동 업데이트는 새
  // 포맷을 로드할 수 없어 브릭을 유발할 수 있으므로, 여기서는 알림만 출력하고
  // 실제 교체는 사용자가 한 번만 수동으로 수행하도록 안내한다.
  console.error(
    `[FLEX-AX] 새 버전 ${latest} 사용 가능 (현재 ${current}).`,
  );
  console.error(
    `[FLEX-AX] flex-ax는 standalone 바이너리 배포로 전환됩니다. npm 자동 업데이트는 중단되었습니다.`,
  );
  console.error(
    `[FLEX-AX] 최신 바이너리: https://github.com/planetarium/flex-ax/releases/latest`,
  );
}
