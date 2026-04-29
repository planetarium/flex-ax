import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { resolveCredentials, saveToKeyring, deleteFromKeyring } from "./credentials.js";

/**
 * status code를 들고 있는 typed 에러. 로그인 단계의 4xx 응답을 정밀하게 식별해
 * "키링 비밀번호 무효화" 같은 분기를 자유 텍스트 매칭 없이 결정할 수 있게 한다.
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

  // 비밀번호: env > 키링 > 프롬프트 순으로 해석. config.flexPassword가 비어있을 때만
  // 키링/프롬프트로 폴백한다 (env 우선 — CI 호환).
  let creds = config.flexPassword
    ? { email: config.flexEmail, password: config.flexPassword, source: "env" as const }
    : await resolveCredentials(config.flexEmail, logger);

  let ctx: AuthContext;
  try {
    ctx = await performLogin(config.flexBaseUrl, creds.email, creds.password, logger);
  } catch (error) {
    // 키링에 저장된 비밀번호가 만료/오타로 인증 거절을 받은 경우, 자동으로 무효화하고
    // 프롬프트로 한 번만 재시도한다. env에서 온 비밀번호는 사용자가 명시적으로
    // 지정한 값이므로 건드리지 않고, prompt에서 온 값은 애초에 키링에 들어있지 않다.
    if (creds.source === "keyring" && isAuthFailure(error) && process.stdin.isTTY) {
      logger.warn("키링에 저장된 비밀번호로 로그인 실패 — 항목을 삭제하고 다시 입력받습니다.");
      deleteFromKeyring(creds.email);
      creds = await resolveCredentials(config.flexEmail, logger);
      ctx = await performLogin(config.flexBaseUrl, creds.email, creds.password, logger);
    } else {
      throw error;
    }
  }

  // 검증을 통과한 비밀번호만 키링에 저장한다.
  // - source === "prompt": 처음 입력받은 값을 다음 실행에서 재사용 가능하게 한다.
  // - source === "keyring"/"env": 이미 저장돼 있거나 사용자가 일회성으로 지정한 값이라 건드리지 않는다.
  if (creds.source === "prompt") {
    saveToKeyring(creds.email, creds.password, logger);
  }
  return ctx;
}

function isAuthFailure(error: unknown): boolean {
  // 자유 텍스트 매칭 대신 typed error로 좁힌다 — 응답 바디에 "HTTP 401" 같은
  // 문자열이 우연히 들어 있어도 트립되지 않는다. 인증 단계의 4xx만을 무효화 시그널로 본다.
  return error instanceof HttpError && error.status >= 400 && error.status < 500;
}

/**
 * 5단계 HTTP 로그인 자체. 키 해석/저장과 분리해서 두면 login 명령에서
 * 입력받은 비밀번호 검증에 그대로 재사용할 수 있다.
 */
export async function performLogin(
  baseUrl: string,
  email: string,
  password: string,
  logger: Logger,
): Promise<AuthContext> {
  const deviceId = randomUUID();

  logger.info("로그인 challenge...");
  const challenge = await postJson<{ sessionId: string }>(
    `${baseUrl}/api-public/v2/auth/challenge`,
    { loginAuthzFlow: false },
    baseHeaders(deviceId),
  );
  const sessionHeaders = baseHeaders(deviceId, { "flexteam-v2-login-session-id": challenge.sessionId });

  logger.info("이메일 검증...");
  await postJson(
    `${baseUrl}/api-public/v2/auth/verification/identifier`,
    { identifier: email },
    sessionHeaders,
  );

  logger.info("비밀번호 인증...");
  await postJson(
    `${baseUrl}/api-public/v2/auth/authentication/password`,
    { password },
    sessionHeaders,
  );

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

  console.log("[FLEX-AX:AUTH] 로그인 성공");
  return {
    baseUrl,
    deviceId,
    workspaceToken: authz.v2Response.workspaceToken.accessToken.token,
    refreshToken: authz.v2Response.workspaceToken.refreshToken.token,
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
