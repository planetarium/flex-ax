import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  downloadAndInstall,
  getCurrentVersion,
  getLatestVersion,
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
  // npm/pnpm bin shim과 symlink는 process.argv[1]를 .../.bin/flex-ax 같이
  // 만들어 dist/cli.js와 매칭되지 않는 경우가 있다. 이 모듈 자체의 위치를
  // 보면 빌드된 dist에서 import된 경로(또는 tsx의 src/.ts)가 그대로 드러나므로
  // 설치 실행과 dev 실행을 안정적으로 구분할 수 있다.
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(path.join("dist", "auto-update.js"));
}

export function compareVersions(a: string, b: string): number {
  const split = (v: string): { base: number[]; pre: string | null } => {
    const dash = v.indexOf("-");
    const baseStr = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? null : v.slice(dash + 1);
    return {
      base: baseStr.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre,
    };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (A.base[i] ?? 0) - (B.base[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // semver: base가 같다면 prerelease 있는 쪽이 더 낮다.
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
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
    // 같은 latest를 계속 잡고 매 호출마다 다운로드/설치를 재시도하면
    // 네트워크나 권한 문제가 지속될 때 에러 로그가 6시간 동안 반복된다.
    // 실패 캐시(FAILURE_TTL)로 전환해 최소 30분은 조용하도록 둔다.
    await writeCache({ checkedAt: Date.now() }).catch(() => {});
    return;
  }

  const result = spawnSync(process.execPath, [process.argv[1]!, ...originalArgs], {
    stdio: "inherit",
    env: { ...process.env, [REENTRY_GUARD_ENV]: "1" },
  });

  if (result.error) {
    console.error(
      `[FLEX-AX] 자동 업데이트 후 재실행 실패: ${result.error.message}`,
    );
    process.exit(1);
  }
  if (result.signal) {
    // 자식이 시그널로 종료된 경우 동일 시그널로 자기 자신을 종료해
    // 호출자가 정확한 종료 사유를 알 수 있도록 한다. Windows 등 일부
    // 플랫폼에서는 미지원 시그널이 ERR_UNKNOWN_SIGNAL을 던질 수 있으므로
    // 그때는 조용히 exit 1로 떨어진다.
    let signalSent = false;
    try {
      process.kill(process.pid, result.signal);
      signalSent = true;
    } catch {
      // ignore — 아래 process.exit으로 fallback
    }
    if (signalSent) {
      // 시그널이 즉시 도착하지 않을 수 있으므로 잠깐 대기. 이벤트 루프가
      // 비어 있으면 unref로 끝나도 process가 자연 종료되지 않으니, 이 경우
      // 100ms 후 fallback으로 exit 1.
      setTimeout(() => process.exit(1), 100).unref();
      return;
    }
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
