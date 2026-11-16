import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { promptLine } from "./credentials.js";
import { deleteSession, loadSession, saveSession, withSessionLock, type PendingLogin, type StoredSession } from "./session.js";

/**
 * status code를 들고 있는 typed 에러. 로그인·갱신 단계의 4xx 응답을 정밀하게 식별해
 * "저장된 세션 무효화" 같은 분기를 자유 텍스트 매칭 없이 결정할 수 있게 한다.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${url}${body ? ` — ${body.slice(0, 300)}` : ""}`);
    this.name = "HttpError";
  }
}

/**
 * 인증 컨텍스트 — Playwright 없이 토큰만 들고 다닌다.
 *
 * 흐름:
 *   1) authenticate(): 저장된 세션 갱신(없으면 이메일 인증 코드 로그인) → workspaceToken 확보
 *   2) listCorporations(): workspaceToken으로 (customer,user) pair 목록 + 메타데이터 조회
 *   3) switchCustomer(): pair → 법인 scope JWT(customerToken=x-flex-aid) 발급
 *   4) flexFetch/flexPost: customerToken을 x-flex-aid 헤더로 실어 호출
 *
 * 서버는 앱 API에서 x-flex-aid만 검증하므로 쿠키 jar는 들고 다니지 않는다.
 */
export interface AuthContext {
  baseUrl: string;
  /** UUID v4. 로그인 + 모든 후속 호출에 flexteam-deviceid 헤더로 동봉 */
  deviceId: string;
  /** 워크스페이스 scope 액세스 JWT — 법인 enumerate / exchange 전용 */
  workspaceToken: string;
  refreshToken: string;
  /** 현재 선택된 법인의 scope JWT. switchCustomer 전에는 null */
  customerToken: string | null;
}

const PRODUCT_HEADERS: Record<string, string> = {
  "x-flex-axios": "base",
  "flexteam-productcode": "FLEX",
  "flexteam-locale": "ko",
};

function baseHeaders(deviceId: string, extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    "flexteam-deviceid": deviceId,
    ...PRODUCT_HEADERS,
    ...(extra ?? {}),
  };
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `POST ${url}`, text);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `GET ${url}`, text);
  }
  return (await res.json()) as T;
}

export async function authenticate(config: Config, logger: Logger): Promise<AuthContext> {
  if (!config.flexEmail) {
    throw new Error(
      "이메일을 찾을 수 없습니다. `flex-ax login`을 한 번 실행하거나 FLEX_EMAIL 환경 변수를 설정하세요.",
    );
  }
  const email = config.flexEmail;

  // 읽기 → 갱신 → 저장을 잠금 안에서 — 동시 실행이 같은 토큰으로 갱신해 서로의 세션을 지우지 않게
  const refreshed = await withSessionLock(async () => {
    const stored = loadSession(email);
    if (!stored) return null;
    const reused = await reuseAccessToken(config.flexBaseUrl, stored.session);
    if (reused) return reused;
    try {
      const result = await refreshSession(config.flexBaseUrl, stored.session.deviceId, stored.session.refreshToken);
      saveSession(email, toStoredSession(result), logger);
      return result.ctx;
    } catch (error) {
      if (!isSessionRejected(error)) throw error;
      logger.warn("저장된 로그인 세션이 만료됐습니다 — 다시 로그인해야 합니다.");
      deleteSession(email);
      return null;
    }
  });
  if (refreshed) return refreshed;

  if (!process.stdin.isTTY) {
    throw new Error(
      "로그인 세션이 없거나 만료됐습니다. 터미널에서 `flex-ax login`을 실행하거나, " +
        "비대화식이면 `flex-ax login --request-code` 후 `flex-ax login --code <코드>`로 로그인하세요.",
    );
  }

  const pending = await requestEmailCode(config.flexBaseUrl, email, logger);
  const code = await promptLine(`[FLEX-AX:AUTH] ${email} 로 받은 인증 코드: `);
  if (!code) throw new Error("인증 코드 입력이 비어 있습니다.");
  const result = await verifyEmailCode(pending, code, logger);
  saveSession(email, toStoredSession(result), logger);
  return result.ctx;
}

/** access token을 새로 받지 않고 그대로 쓰려면 남아 있어야 하는 시간 */
const ACCESS_REUSE_MIN_REMAINING_MS = 60 * 60 * 1000;

/**
 * 저장된 access token이 아직 넉넉히 남았으면 가벼운 조회 한 번으로 살아 있는지 확인하고 그대로 쓴다.
 * 갱신하면 이전 access token이 즉시 무효가 되어(2026-11-16 실측) 동시에 도는 다른 실행이 401을 받기 때문.
 * 확인에 실패하면 null — 호출자가 refresh로 넘어간다.
 */
async function reuseAccessToken(baseUrl: string, session: StoredSession): Promise<AuthContext | null> {
  if (!session.accessToken || !session.accessExpireAt) return null;
  if (Date.parse(session.accessExpireAt) - Date.now() < ACCESS_REUSE_MIN_REMAINING_MS) return null;
  try {
    await getJson(
      `${baseUrl}/api-public/v2/auth/tokens/customer-user`,
      baseHeaders(session.deviceId, { "flexteam-v2-workspace-access": session.accessToken }),
    );
  } catch {
    return null;
  }
  return {
    baseUrl,
    deviceId: session.deviceId,
    workspaceToken: session.accessToken,
    refreshToken: session.refreshToken,
    customerToken: null,
  };
}

/**
 * 서버가 refresh token 자체를 거절했는지. 만료·무효 토큰은 401 또는
 * `400 {"code":"AUTH_400_000"}`(2026-11-16 실측)으로 온다. 그 밖의 4xx(403 차단, 404 경로 변경,
 * 429 등)는 세션 문제로 단정할 수 없으므로 세션을 지우지 않는다 — 지우면 메일 코드 재로그인이 필요하다.
 */
function isSessionRejected(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status === 401) return true;
  if (error.status !== 400) return false;
  try {
    const code = (JSON.parse(error.body) as { code?: unknown }).code;
    return typeof code === "string" && code.startsWith("AUTH_");
  } catch {
    return false;
  }
}

interface TokenPair {
  accessToken: { token: string; expireAt: string };
  refreshToken: { token: string; expireAt: string };
}

export interface LoginResult {
  ctx: AuthContext;
  /** refresh token 만료 시각(ISO). 갱신할 때마다 7일 뒤로 밀린다 */
  refreshExpireAt: string;
  /** access token 만료 시각(ISO, 약 12시간) */
  accessExpireAt: string;
}

export function toStoredSession(result: LoginResult): StoredSession {
  return {
    refreshToken: result.ctx.refreshToken,
    refreshExpireAt: result.refreshExpireAt,
    deviceId: result.ctx.deviceId,
    accessToken: result.ctx.workspaceToken,
    accessExpireAt: result.accessExpireAt,
  };
}

function toLoginResult(baseUrl: string, deviceId: string, tokens: TokenPair): LoginResult {
  return {
    ctx: {
      baseUrl,
      deviceId,
      workspaceToken: tokens.accessToken.token,
      refreshToken: tokens.refreshToken.token,
      customerToken: null,
    },
    refreshExpireAt: tokens.refreshToken.expireAt,
    accessExpireAt: tokens.accessToken.expireAt,
  };
}

/**
 * 이메일 인증 코드 로그인 1단계 — challenge → 이메일 확인 → 코드 메일 발송.
 * 반환값을 verifyEmailCode에 넘기면 로그인이 끝난다. 두 단계를 다른 프로세스로
 * 나눠 실행할 수 있도록(login --request-code / --code) 직렬화 가능한 값만 담는다.
 */
export async function requestEmailCode(baseUrl: string, email: string, logger: Logger): Promise<PendingLogin> {
  const deviceId = randomUUID();

  logger.info("로그인 challenge...");
  const challenge = await postJson<{ sessionId: string }>(
    `${baseUrl}/api-public/v2/auth/challenge`,
    { loginAuthzFlow: false },
    baseHeaders(deviceId),
  );
  const sessionHeaders = baseHeaders(deviceId, { "flexteam-v2-login-session-id": challenge.sessionId });

  logger.info("이메일 검증...");
  const identified = await postJson<{ nextStep?: string }>(
    `${baseUrl}/api-public/v2/auth/verification/identifier`,
    { identifier: email },
    sessionHeaders,
  );
  if (identified.nextStep && identified.nextStep !== "AUTHENTICATION") {
    throw new Error(
      `이 계정은 이메일 인증 코드 로그인을 쓸 수 없습니다 (nextStep=${identified.nextStep}). SSO 계정은 지원하지 않습니다.`,
    );
  }

  logger.info("인증 코드 메일 발송...");
  const issued = await postJson<{ expiresAt: string; maskedEmail?: string }>(
    `${baseUrl}/api-public/v2/auth/authentication/email-otp.issue-code`,
    {},
    sessionHeaders,
  );
  process.stderr.write(
    `[FLEX-AX:AUTH] 인증 코드를 ${issued.maskedEmail ?? email} 로 보냈습니다 (만료 ${issued.expiresAt})\n`,
  );

  return { baseUrl, email, deviceId, sessionId: challenge.sessionId, codeExpiresAt: issued.expiresAt };
}

/** 이메일 인증 코드 로그인 2단계 — 코드 확인 → 토큰 발급. */
export async function verifyEmailCode(pending: PendingLogin, code: string, logger: Logger): Promise<LoginResult> {
  const sessionHeaders = baseHeaders(pending.deviceId, { "flexteam-v2-login-session-id": pending.sessionId });

  logger.info("인증 코드 확인...");
  const verified = await postJson<{ nextStep?: string }>(
    `${pending.baseUrl}/api-public/v2/auth/authentication/email-otp`,
    { code: code.trim() },
    sessionHeaders,
  );
  if (verified.nextStep && verified.nextStep !== "AUTHORIZATION") {
    // 2단계 인증(TOTP 등)이 켜진 계정 — 아직 지원하지 않는다
    throw new Error(`추가 인증 단계가 필요한 계정은 지원하지 않습니다 (nextStep=${verified.nextStep}).`);
  }

  logger.info("토큰 발급...");
  const authz = await postJson<{ v2Response: { workspaceToken: TokenPair } }>(
    `${pending.baseUrl}/api-public/v2/auth/authorization`,
    {},
    sessionHeaders,
  );

  // logger와 동일하게 stderr로 — stdout은 명령 결과물 전용으로 비워둔다
  process.stderr.write("[FLEX-AX:AUTH] 로그인 성공\n");
  return toLoginResult(pending.baseUrl, pending.deviceId, authz.v2Response.workspaceToken);
}

/** 저장된 refresh token으로 새 access token을 받는다. refresh token도 새것으로 바뀐다. */
export async function refreshSession(baseUrl: string, deviceId: string, refreshToken: string): Promise<LoginResult> {
  const tokens = await postJson<TokenPair>(
    `${baseUrl}/api-public/v2/auth/tokens/workspace/refresh`,
    {},
    baseHeaders(deviceId, { "flexteam-v2-workspace-refresh": refreshToken }),
  );
  return toLoginResult(baseUrl, deviceId, tokens);
}

export interface Corporation {
  customerIdHash: string;
  userIdHash: string;
  name: string;
  isRepresentative: boolean;
  displayOrder: number;
}

interface CustomerUserPair {
  customerUuid: string;
  userUuid: string;
}

interface AffiliatesResponse {
  currentUser?: {
    customer: { customerIdHash: string; name: string; isRepresentative: boolean; displayOrder: number };
    user: { userIdHash: string };
  };
  users: Array<{
    customer: { customerIdHash: string; name: string; isRepresentative: boolean; displayOrder: number };
    user: { userIdHash: string };
  }>;
}

/**
 * 사용자가 속한 법인 목록을 메타데이터(이름, 대표법인 여부 등)와 함께 반환한다.
 *
 * 두 단계로 나뉜다:
 *   a) `GET /api-public/v2/auth/tokens/customer-user` — workspaceToken만으로 (customer,user) pair 나열
 *   b) 첫 pair로 bootstrap exchange → x-flex-aid 확보 → `affiliates` API로 메타데이터 보강
 *
 * caller는 반환된 목록을 받아 법인별로 다시 switchCustomer를 호출한다.
 */
export async function listCorporations(authCtx: AuthContext, baseUrl: string): Promise<Corporation[]> {
  const pairs = await getJson<CustomerUserPair[]>(
    `${baseUrl}/api-public/v2/auth/tokens/customer-user`,
    baseHeaders(authCtx.deviceId, { "flexteam-v2-workspace-access": authCtx.workspaceToken }),
  );
  if (pairs.length === 0) return [];

  // 메타데이터(이름 등) 보강용 bootstrap exchange. 호출 직후 caller가 다시 switchCustomer를
  // 부르므로 여기서 customerToken이 어떤 법인이든 상관없다.
  await switchCustomer(authCtx, baseUrl, pairs[0].customerUuid, pairs[0].userUuid);

  const affiliates = await getJson<AffiliatesResponse>(
    `${baseUrl}/api/v2/core/users/me/workspace-users-corp-group-affiliates`,
    apiHeaders(authCtx),
  );

  const fromUsers = affiliates.users.map((u) => ({
    customerIdHash: u.customer.customerIdHash,
    userIdHash: u.user.userIdHash,
    name: u.customer.name,
    isRepresentative: u.customer.isRepresentative,
    displayOrder: u.customer.displayOrder,
  }));
  if (fromUsers.length > 0) return fromUsers;

  if (affiliates.currentUser) {
    return [
      {
        customerIdHash: affiliates.currentUser.customer.customerIdHash,
        userIdHash: affiliates.currentUser.user.userIdHash,
        name: affiliates.currentUser.customer.name,
        isRepresentative: affiliates.currentUser.customer.isRepresentative,
        displayOrder: affiliates.currentUser.customer.displayOrder,
      },
    ];
  }

  // pair는 있지만 affiliates가 비어있는 비정상 상황 — pair 정보만으로 fallback
  return pairs.map((p, idx) => ({
    customerIdHash: p.customerUuid,
    userIdHash: p.userUuid,
    name: p.customerUuid,
    isRepresentative: idx === 0,
    displayOrder: idx,
  }));
}

/**
 * 지정 법인 scope의 JWT를 발급받아 authCtx.customerToken에 주입한다.
 * 이후 모든 앱 API 호출은 이 토큰의 scope으로 동작한다.
 */
export async function switchCustomer(
  authCtx: AuthContext,
  baseUrl: string,
  customerIdHash: string,
  userIdHash: string,
): Promise<void> {
  const resp = await postJson<{ token: string }>(
    `${baseUrl}/api-public/v2/auth/tokens/customer-user/exchange`,
    { customerUuid: customerIdHash, userUuid: userIdHash },
    baseHeaders(authCtx.deviceId, { "flexteam-v2-workspace-access": authCtx.workspaceToken }),
  );
  if (!resp?.token) {
    throw new Error(`회사 전환 토큰 발급 실패: customerIdHash=${customerIdHash}`);
  }
  authCtx.customerToken = resp.token;
}

/**
 * 앱 API(/api/, /action/) 호출에 동봉할 헤더 셋을 만든다.
 * customerToken이 있으면 x-flex-aid로 동봉.
 */
export function apiHeaders(authCtx: AuthContext, extra?: Record<string, string>): Record<string, string> {
  const headers = baseHeaders(authCtx.deviceId, extra);
  if (authCtx.customerToken) {
    headers["x-flex-aid"] = authCtx.customerToken;
  }
  return headers;
}

/** Node 기반 인증은 닫을 리소스가 없지만 호출자 코드 호환을 위해 유지한다. */
export async function cleanup(_authCtx: AuthContext): Promise<void> {
  // no-op
}
