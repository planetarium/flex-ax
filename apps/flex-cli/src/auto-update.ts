import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import semver from "semver";

import {
  downloadAndInstall,
  downloadBinaryAndReplace,
  getCurrentVersion,
  getLatestVersion,
} from "./commands/update.js";
import { isStandaloneBinary } from "./runtime.js";

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
  // bun compile 바이너리는 자기 자신이 곧 설치 결과이므로 항상 installed로 취급.
  if (isStandaloneBinary()) return true;
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
    if (isStandaloneBinary()) {
      await downloadBinaryAndReplace(latest);
    } else {
      await downloadAndInstall(latest);
    }
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

  // 바이너리 모드에선 execPath가 곧 새 바이너리이므로 스크립트 경로를 인자에
  // 넣지 않는다. npm 배포 모드에선 node가 script 파일을 읽어야 하므로 argv[1]
  // (cli.js 경로)을 반드시 앞에 둔다.
  const spawnArgs = isStandaloneBinary()
    ? [...originalArgs]
    : [process.argv[1]!, ...originalArgs];
  const result = spawnSync(process.execPath, spawnArgs, {
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
