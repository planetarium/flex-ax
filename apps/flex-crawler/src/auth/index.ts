import { randomUUID } from "node:crypto";
import type { CrawlerConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

/**
 * 토큰 기반 인증 컨텍스트 — Playwright 없이 동작.
 *
 * authenticate()로 워크스페이스 토큰을 받고, 필요 시 customerToken을 발급받아
 * x-flex-aid 헤더로 앱 API에 동봉한다.
 */
export interface AuthContext {
  baseUrl: string;
  deviceId: string;
  workspaceToken: string;
  refreshToken: string;
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

export async function authenticate(
  config: CrawlerConfig,
  logger: Logger,
): Promise<AuthContext> {
  if (!config.flexEmail || !config.flexPassword) {
    throw new Error("FLEX_EMAIL과 FLEX_PASSWORD 환경 변수가 필요합니다.");
  }

  const deviceId = randomUUID();
  const baseUrl = config.flexBaseUrl;

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
    { identifier: config.flexEmail },
    sessionHeaders,
  );

  logger.info("비밀번호 인증...");
  await postJson(
    `${baseUrl}/api-public/v2/auth/authentication/password`,
    { password: config.flexPassword },
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

  // flex-crawler는 단일 법인 경로(현재 사용자 default)로 동작하므로,
  // 로그인 직후 default customer-user pair로 즉시 exchange하여 customerToken을 채운다.
  const pairsRes = await fetch(
    `${baseUrl}/api-public/v2/auth/tokens/customer-user`,
    {
      headers: baseHeaders(deviceId, {
        "flexteam-v2-workspace-access": authz.v2Response.workspaceToken.accessToken.token,
      }),
    },
  );
  if (!pairsRes.ok) {
    throw new Error(`customer-user pair 조회 실패: HTTP ${pairsRes.status}`);
  }
  const pairs = (await pairsRes.json()) as Array<{ customerUuid: string; userUuid: string }>;
  if (pairs.length === 0) {
    throw new Error("접근 가능한 법인이 없습니다.");
  }

  const ctx: AuthContext = {
    baseUrl,
    deviceId,
    workspaceToken: authz.v2Response.workspaceToken.accessToken.token,
    refreshToken: authz.v2Response.workspaceToken.refreshToken.token,
    customerToken: null,
  };
  await switchCustomer(ctx, pairs[0].customerUuid, pairs[0].userUuid);

  logger.info("로그인 성공");
  return ctx;
}

async function switchCustomer(
  authCtx: AuthContext,
  customerUuid: string,
  userUuid: string,
): Promise<void> {
  const resp = await postJson<{ token: string }>(
    `${authCtx.baseUrl}/api-public/v2/auth/tokens/customer-user/exchange`,
    { customerUuid, userUuid },
    baseHeaders(authCtx.deviceId, { "flexteam-v2-workspace-access": authCtx.workspaceToken }),
  );
  authCtx.customerToken = resp.token;
}

/** 앱 API용 헤더 셋 — x-flex-aid + base 헤더 */
export function apiHeaders(authCtx: AuthContext, extra?: Record<string, string>): Record<string, string> {
  const headers = baseHeaders(authCtx.deviceId, extra);
  if (authCtx.customerToken) {
    headers["x-flex-aid"] = authCtx.customerToken;
  }
  return headers;
}

/**
 * 세션 유효성을 가볍게 확인한다. 401이면 재로그인.
 *
 * 토큰 만료 시 새 컨텍스트를 만들어 기존 객체에 덮어쓰는 식으로,
 * 호출자가 들고 있는 authCtx 참조를 그대로 유지한다.
 */
export async function ensureAuthenticated(
  authCtx: AuthContext,
  config: CrawlerConfig,
  logger: Logger,
): Promise<void> {
  try {
    const res = await fetch(`${authCtx.baseUrl}/api/v2/core/me`, { headers: apiHeaders(authCtx) });
    if (res.status !== 401) return;
    logger.warn("세션 만료 감지, 재인증 시도...");
  } catch {
    logger.warn("세션 확인 실패, 재인증 시도...");
  }

  const fresh = await authenticate(config, logger);
  authCtx.baseUrl = fresh.baseUrl;
  authCtx.deviceId = fresh.deviceId;
  authCtx.workspaceToken = fresh.workspaceToken;
  authCtx.refreshToken = fresh.refreshToken;
  authCtx.customerToken = fresh.customerToken;
}

/** Node 인증은 닫을 리소스가 없지만 호환성을 위해 유지. */
export async function cleanup(_authCtx: AuthContext): Promise<void> {
  // no-op
}
