import { Entry } from "@napi-rs/keyring";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "../logger/index.js";

/**
 * 로그인 세션(워크스페이스 refresh token) 저장소.
 *
 * flex는 2026-11-11부터 비밀번호 로그인을 없애고 이메일 인증 코드 로그인만 허용한다.
 * 코드는 매번 메일로 받아야 하므로, 한 번 로그인해 얻은 refresh token을 저장해 두고
 * 실행마다 `tokens/workspace/refresh`로 새 access token을 받는다.
 * refresh token은 7일 유효이고 갱신할 때마다 새 토큰(새 7일)으로 바뀐다 —
 * 7일 안에 한 번이라도 실행하면 다시 로그인할 필요가 없다.
 *
 * 저장 위치:
 *   - FLEX_SESSION_FILE 지정 시 그 파일(0600)만 사용 — 키링이 없거나 휘발성인
 *     헤드리스 서버(cron·ssh 실행)용
 *   - 아니면 OS 키링(service=flex-ax, account=session:<email>),
 *     키링 사용 불가 시 ~/.flex-ax/session.json(0600)로 폴백
 */
export interface StoredSession {
  refreshToken: string;
  /** refresh token 만료 시각(ISO) — status 표시·만료 판단용 */
  refreshExpireAt: string;
  /** 로그인 때 쓴 flexteam-deviceid. 갱신도 같은 기기 id로 보낸다 */
  deviceId: string;
  /**
   * 마지막으로 받은 workspace access token(12시간 유효)과 만료 시각.
   * 갱신하면 이전 access token이 바로 무효가 되므로, 동시에 도는 실행끼리 서로의 토큰을
   * 죽이지 않게 남은 시간이 넉넉하면 갱신 없이 이 토큰을 같이 쓴다.
   */
  accessToken?: string;
  accessExpireAt?: string;
}

/** `login --request-code` 와 `login --code` 사이에 이어 붙일 로그인 세션 */
export interface PendingLogin {
  baseUrl: string;
  email: string;
  deviceId: string;
  sessionId: string;
  /** 인증 코드 만료 시각(ISO) */
  codeExpiresAt: string;
}

const KEYRING_SERVICE = "flex-ax";
/** 호출 시점에 해석 — HOME을 바꾼 실행(테스트·전용 HOME으로 띄운 서버)에서도 그 폴더를 쓴다 */
function defaultDir(): string {
  return join(process.env.HOME || homedir(), ".flex-ax");
}

function sessionAccount(email: string): string {
  return `session:${email}`;
}

export function getSessionFilePath(): string {
  return process.env.FLEX_SESSION_FILE || join(defaultDir(), "session.json");
}

function getPendingFilePath(): string {
  return join(dirname(getSessionFilePath()), "pending-login.json");
}

function forceFile(): boolean {
  return Boolean(process.env.FLEX_SESSION_FILE);
}

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 임시 파일(0600)에 쓰고 rename — 중간에 죽어도 찢어진 JSON·넓은 권한이 남지 않는다 */
function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

/**
 * refresh token은 갱신할 때마다 바뀌므로, 두 실행이 같은 토큰으로 동시에 갱신하면
 * 늦은 쪽이 거절당하고 세션을 지울 수 있다. 세션 읽기 → 갱신 → 저장을 잠금 파일로 직렬화한다.
 * 비정상 종료로 남은 잠금은 LOCK_STALE_MS 뒤 무시한다.
 */
export async function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = join(dirname(getSessionFilePath()), "session.lock");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // 그 사이 풀림
      }
      if (Date.now() > deadline) {
        throw new Error(`로그인 세션 잠금을 얻지 못했습니다 (${lockPath}) — 다른 flex-ax 실행이 끝난 뒤 다시 시도하세요.`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function isStoredSession(v: unknown): v is StoredSession {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.refreshToken === "string" && typeof s.deviceId === "string" && typeof s.refreshExpireAt === "string";
}

type SessionFile = Record<string, StoredSession>;

function readFromFile(email: string): StoredSession | null {
  const all = readJsonFile<SessionFile>(getSessionFilePath());
  const s = all?.[email];
  return isStoredSession(s) ? s : null;
}

function writeToFile(email: string, session: StoredSession | null): void {
  const path = getSessionFilePath();
  const all = readJsonFile<SessionFile>(path) ?? {};
  if (session) {
    all[email] = session;
  } else {
    if (!(email in all)) return;
    delete all[email];
  }
  writePrivateJson(path, all);
}

export type SessionSource = "file" | "keyring";

export function loadSession(email: string): { session: StoredSession; source: SessionSource } | null {
  if (!forceFile()) {
    try {
      const raw = new Entry(KEYRING_SERVICE, sessionAccount(email)).getPassword();
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (isStoredSession(parsed)) return { session: parsed, source: "keyring" };
      }
    } catch {
      // 키링 백엔드 없음/깨진 값 — 파일 폴백
    }
  }
  const fromFile = readFromFile(email);
  return fromFile ? { session: fromFile, source: "file" } : null;
}

/**
 * 갱신 때마다 refresh token이 바뀌므로 저장 실패는 다음 실행의 재로그인으로 이어진다.
 * 키링 실패 시 파일로 폴백하고, 둘 다 실패하면 error 로그를 남기고 false를 돌려준다
 * (서버 쪽 토큰은 이미 바뀌었으므로 이번 실행 자체는 계속한다).
 */
export function saveSession(email: string, session: StoredSession, logger: Logger): boolean {
  if (!forceFile()) {
    // Entry 생성도 실패할 수 있다(Linux 백엔드 생성 오류 등) — 생성까지 try 안에 두어 파일 폴백에 닿게 한다
    let entry: Entry | null = null;
    try {
      entry = new Entry(KEYRING_SERVICE, sessionAccount(email));
      entry.setPassword(JSON.stringify(session));
      // 예전에 파일 폴백으로 저장된 값이 남아 있으면 오래된 토큰이 다시 읽히지 않게 지운다
      writeToFile(email, null);
      return true;
    } catch {
      // 키링에 남은 이전 토큰이 파일의 새 토큰보다 먼저 읽히지 않게 지운다
      try {
        entry?.deletePassword();
      } catch {
        // 없음
      }
      logger.warn("키링 저장 실패 — 세션 파일로 저장합니다", { path: getSessionFilePath() });
    }
  }
  try {
    writeToFile(email, session);
    return true;
  } catch (error) {
    logger.error("로그인 세션 저장 실패 — 다음 실행에서 다시 로그인해야 합니다 (`flex-ax login`)", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function deleteSession(email: string): boolean {
  let removed = false;
  if (!forceFile()) {
    try {
      removed = new Entry(KEYRING_SERVICE, sessionAccount(email)).deletePassword() || removed;
    } catch {
      // 없음
    }
  }
  try {
    if (readFromFile(email)) {
      writeToFile(email, null);
      removed = true;
    }
  } catch {
    // 파일 접근 불가 — 지울 것도 없음
  }
  return removed;
}

/**
 * 비밀번호 로그인 시절(≤0.9.x)에 키링(service=flex-ax, account=<email>)에 저장한 비밀번호.
 * 더는 쓰지 않으므로 login/logout 때 지운다.
 */
export function deleteLegacyPassword(email: string): boolean {
  try {
    return new Entry(KEYRING_SERVICE, email).deletePassword();
  } catch {
    return false;
  }
}

export function savePending(pending: PendingLogin): void {
  writePrivateJson(getPendingFilePath(), pending);
}

export function loadPending(): PendingLogin | null {
  return readJsonFile<PendingLogin>(getPendingFilePath());
}

export function deletePending(): void {
  rmSync(getPendingFilePath(), { force: true });
}
