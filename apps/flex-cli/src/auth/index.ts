import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

/**
 * 인증 컨텍스트 — Playwright 없이 토큰만 들고 다닌다.
 *
 * 흐름:
 *   1) authenticate(): credentials 로그인 → workspaceToken 확보
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
    throw new Error(`HTTP ${res.status} POST ${url} — ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} GET ${url} — ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function authenticate(config: Config, logger: Logger): Promise<AuthContext> {
  if (!config.flexEmail || !config.flexPassword) {
    throw new Error("FLEX_EMAIL과 FLEX_PASSWORD 환경 변수가 필요합니다.");
  }

  const deviceId = randomUUID();
  const baseUrl = config.flexBaseUrl;

  // 1) challenge — 로그인 세션 발급
  logger.info("로그인 challenge...");
  const challenge = await postJson<{ sessionId: string }>(
    `${baseUrl}/api-public/v2/auth/challenge`,
    { loginAuthzFlow: false },
    baseHeaders(deviceId),
  );
  const sessionId = challenge.sessionId;
  const sessionHeaders = baseHeaders(deviceId, { "flexteam-v2-login-session-id": sessionId });

  // 2) identifier(이메일) 검증
  logger.info("이메일 검증...");
  await postJson(
    `${baseUrl}/api-public/v2/auth/verification/identifier`,
    { identifier: config.flexEmail },
    sessionHeaders,
  );

  // 3) password
  logger.info("비밀번호 인증...");
  await postJson(
    `${baseUrl}/api-public/v2/auth/authentication/password`,
    { password: config.flexPassword },
    sessionHeaders,
  );

  // 4) authorization — 워크스페이스 토큰 발급
  logger.info("토큰 발급...");
  type AuthorizationResponse = {
    v2Response: {
      workspaceToken: {
        accessToken: { token: string; expireAt: string };
        refreshToken: { token: string; expireAt: string };
      };
    };
  };
  const authz = await postJson<AuthorizationResponse>(
    `${baseUrl}/api-public/v2/auth/authorization`,
    {},
    sessionHeaders,
  );
  const workspaceToken = authz.v2Response.workspaceToken.accessToken.token;
  const refreshToken = authz.v2Response.workspaceToken.refreshToken.token;

  console.log("[FLEX-AX:AUTH] 로그인 성공");
  return {
    baseUrl,
    deviceId,
    workspaceToken,
    refreshToken,
    customerToken: null,
  };
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
