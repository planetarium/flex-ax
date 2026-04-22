import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export interface AuthContext {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  authHeaders: Record<string, string>;
}

/**
 * Check that Playwright's bundled Chromium browser is available.
 * Fails early with a helpful message instead of crashing mid-auth.
 */
function ensurePlaywrightBrowser(): void {
  const execPath = chromium.executablePath();
  if (!fs.existsSync(execPath)) {
    console.error(
      "[FLEX-AX:ERROR] Playwright Chromium browser is not installed.\n" +
      "Please run: npx playwright install chromium",
    );
    process.exit(1);
  }
}

export async function authenticate(
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  // All auth modes eventually launch a local Chromium — verify it exists first
  ensurePlaywrightBrowser();

  if (config.authMode === "playwriter") {
    return authenticatePlaywriter(config, logger);
  }

  if (config.authMode === "sso") {
    return authenticateSSO(config, logger);
  }
  return authenticateCredentials(config, logger);
}

function setupHeaderCapture(
  page: Page,
  authHeaders: Record<string, string>,
  baseUrl: string,
): void {
  const baseHostname = new URL(baseUrl).hostname;
  page.on("request", (request) => {
    const url = request.url();
    try {
      const reqHostname = new URL(url).hostname;
      if (reqHostname === baseHostname && (url.includes("/api/") || url.includes("/action/"))) {
        const headers = request.headers();
        // x-flex-aid는 switchCustomer가 전담 관리한다.
        // 여기서 캡처하면 법인 전환 후에도 페이지의 백그라운드 요청이 원래 scope의
        // JWT를 헤더로 실어오고, authHeaders["x-flex-aid"]를 원본 값으로 되돌려버린다.
        // 그 결과 이후 모든 크롤 요청이 전환된 법인이 아닌 로그인 시점의 법인 scope으로
        // 동작해 멀티-법인 크롤이 같은 데이터만 반복 수집하게 된다.
        for (const key of ["authorization", "cookie", "x-csrf-token", "x-flex-axios"]) {
          if (headers[key]) {
            authHeaders[key] = headers[key];
          }
        }
      }
    } catch {
      // invalid URL, skip
    }
  });
}

async function collectCookies(
  context: BrowserContext,
  authHeaders: Record<string, string>,
  baseUrl: string,
): Promise<void> {
  const targetUrl = new URL(baseUrl).origin;
  const cookies = await context.cookies(targetUrl);
  if (cookies.length > 0) {
    authHeaders["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

async function authenticateCredentials(
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  if (!config.flexEmail || !config.flexPassword) {
    throw new Error("FLEX_EMAIL and FLEX_PASSWORD are required when AUTH_MODE is 'credentials'");
  }
  logger.info("브라우저 시작...");
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  const authHeaders: Record<string, string> = {};
  setupHeaderCapture(page, authHeaders, config.flexBaseUrl);

  logger.info("flex 로그인 페이지 이동...");
  await page.goto(`${config.flexBaseUrl}/login`, { waitUntil: "networkidle" });

  logger.info("이메일 입력...");
  const emailInput = page.locator('input[type="email"]');
  await emailInput.fill(config.flexEmail);
  await emailInput.press("Enter");

  logger.info("비밀번호 입력...");
  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 10000 });
  await passwordInput.fill(config.flexPassword);
  await page.locator('button[type="submit"]').click();

  logger.info("로그인 완료 대기...");
  await page.waitForURL((url) => !url.toString().includes("/auth/login"), {
    timeout: 30000,
  });

  await page.waitForLoadState("networkidle");
  await collectCookies(context, authHeaders, config.flexBaseUrl);

  console.log("[FLEX-AX:AUTH] 로그인 성공");
  return { browser, context, page, authHeaders };
}

async function authenticateSSO(
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  logger.info("SSO 모드: 브라우저를 열어 수동 로그인을 진행합니다.");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const authHeaders: Record<string, string> = {};
  setupHeaderCapture(page, authHeaders, config.flexBaseUrl);

  await page.goto(`${config.flexBaseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });

  console.log("[FLEX-AX:AUTH] 브라우저에서 로그인을 완료해 주세요");

  // 로그인 완료 대기 (최대 5분)
  await page.waitForURL(
    (url) => {
      const s = url.toString();
      return (
        !s.includes("/login") &&
        !s.includes("/auth/") &&
        !s.includes("accounts.google.com")
      );
    },
    { timeout: 300_000 },
  );

  await page.waitForLoadState("networkidle").catch(() => {});
  await collectCookies(context, authHeaders, config.flexBaseUrl);

  console.log("[FLEX-AX:AUTH] 로그인 성공");
  return { browser, context, page, authHeaders };
}

const PLAYWRITER_CDP_URL = "http://127.0.0.1:19988";

async function authenticatePlaywriter(
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  logger.info("Playwriter 모드: Extension CDP relay로 기존 Chrome 세션에 연결합니다.");

  // 1. Playwriter Extension의 CDP relay에 연결
  let remoteBrowser: Browser;
  try {
    remoteBrowser = await chromium.connectOverCDP(PLAYWRITER_CDP_URL, { timeout: 10000 });
  } catch {
    throw new Error(
      `Playwriter CDP relay(${PLAYWRITER_CDP_URL})에 연결할 수 없습니다. ` +
      "Playwriter Extension이 활성화되어 있고, 대상 탭에서 Extension 아이콘을 클릭했는지 확인하세요.",
    );
  }

  // 2. 연결된 탭에서 쿠키 추출
  const contexts = remoteBrowser.contexts();
  if (contexts.length === 0) {
    remoteBrowser.close().catch(() => {});
    throw new Error("Playwriter에 연결된 브라우저 컨텍스트가 없습니다.");
  }

  const remoteContext = contexts[0];
  const pages = remoteContext.pages();
  if (pages.length === 0) {
    remoteBrowser.close().catch(() => {});
    throw new Error("Playwriter에 연결된 탭이 없습니다. Chrome에서 flex.team 탭을 열고 Extension 아이콘을 클릭하세요.");
  }

  // flex.team 탭 찾기, 없으면 첫 번째 탭에서 이동
  let remotePage = pages.find((p) => p.url().includes(new URL(config.flexBaseUrl).hostname));
  if (!remotePage) {
    remotePage = pages[0];
    await remotePage.goto(config.flexBaseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  }

  // httpOnly 쿠키까지 포함하도록 Playwright context API로 전체 쿠키를 수집한다.
  // (document.cookie는 httpOnly 쿠키를 반환하지 않으므로 V2_WS_AID 등이 누락될 수 있다.)
  const origin = new URL(config.flexBaseUrl).origin;
  let remoteCookies = await remoteContext.cookies(origin).catch(() => [] as Awaited<ReturnType<typeof remoteContext.cookies>>);
  let usedFallback = false;

  // context.cookies()가 빈 배열을 주면 document.cookie로 폴백
  let cookieStr: string;
  if (remoteCookies.length > 0) {
    cookieStr = remoteCookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } else {
    usedFallback = true;
    cookieStr = await remotePage.evaluate(() => document.cookie);
    remoteCookies = cookieStr
      .split(";")
      .map((pair) => {
        const [name, ...rest] = pair.trim().split("=");
        return {
          name: name.trim(),
          value: rest.join("="),
          domain: new URL(config.flexBaseUrl).hostname,
          path: "/",
        };
      })
      .filter((c) => c.name && c.value) as typeof remoteCookies;
  }

  // CDP 연결 해제 (사용자 브라우저는 닫지 않음)
  remoteBrowser.close().catch(() => {});

  if (remoteCookies.length === 0) {
    throw new Error(
      "Playwriter에서 쿠키를 가져올 수 없습니다. " +
      "Chrome에서 flex.team에 로그인되어 있는지 확인하세요.",
    );
  }

  // 멀티-법인 전환에 필수인 V2_WS_AID가 확보됐는지 즉시 검증한다.
  // 폴백 경로(document.cookie)에서는 httpOnly 쿠키를 얻을 수 없으므로 여기서 빠르게 실패시킨다.
  const hasWsAid = remoteCookies.some((c) => c.name === "V2_WS_AID");
  if (!hasWsAid) {
    const hint = usedFallback
      ? "httpOnly 쿠키를 가져올 수 없는 경로(document.cookie 폴백)라 V2_WS_AID를 얻지 못했을 수 있습니다. Playwriter Extension 연결 상태를 확인하세요."
      : "Chrome에서 flex.team에 다시 로그인하면 갱신됩니다.";
    throw new Error(`V2_WS_AID 쿠키를 찾을 수 없습니다 — 법인 전환(switchCustomer)이 불가능합니다. ${hint}`);
  }

  logger.info(`쿠키 ${remoteCookies.length}개 확보`);

  // 3. headless 브라우저에 쿠키 주입
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(remoteCookies);

  const page = await context.newPage();
  const authHeaders: Record<string, string> = { cookie: cookieStr };
  setupHeaderCapture(page, authHeaders, config.flexBaseUrl);

  // 4. 쿠키가 유효한지 확인
  await page.goto(config.flexBaseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth/")) {
    await cleanup({ browser, context, page, authHeaders });
    throw new Error("Playwriter에서 가져온 쿠키가 만료되었습니다. Chrome에서 flex.team에 다시 로그인하세요.");
  }

  console.log("[FLEX-AX:AUTH] Playwriter CDP relay로 로그인 성공");
  return { browser, context, page, authHeaders };
}

export interface Corporation {
  customerIdHash: string;
  userIdHash: string;
  name: string;
  isRepresentative: boolean;
  displayOrder: number;
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
 * 현재 로그인한 사용자가 속한 법인(회사) 목록을 조회한다.
 * `users` 배열에 (회사 × 유저) 페어가 들어있고, 회사마다 userIdHash가 다르다.
 */
export async function listCorporations(authCtx: AuthContext, baseUrl: string): Promise<Corporation[]> {
  const url = `${baseUrl}/api/v2/core/users/me/workspace-users-corp-group-affiliates`;
  const data = await authCtx.page.evaluate(
    async ([fetchUrl, headers]) => {
      const res = await fetch(fetchUrl, { headers: headers as Record<string, string> });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${fetchUrl}`);
      return (await res.json()) as AffiliatesResponse;
    },
    [url, authCtx.authHeaders] as const,
  );

  const fromUsers = data.users.map((u) => ({
    customerIdHash: u.customer.customerIdHash,
    userIdHash: u.user.userIdHash,
    name: u.customer.name,
    isRepresentative: u.customer.isRepresentative,
    displayOrder: u.customer.displayOrder,
  }));

  if (fromUsers.length > 0) return fromUsers;

  // fallback: currentUser만 있는 경우
  if (data.currentUser) {
    return [
      {
        customerIdHash: data.currentUser.customer.customerIdHash,
        userIdHash: data.currentUser.user.userIdHash,
        name: data.currentUser.customer.name,
        isRepresentative: data.currentUser.customer.isRepresentative,
        displayOrder: data.currentUser.customer.displayOrder,
      },
    ];
  }

  return [];
}

/**
 * 지정된 법인 컨텍스트용 JWT를 발급받아 authHeaders에 주입한다.
 * 이후 모든 flex API 호출은 해당 법인 스코프로 동작한다.
 *
 * 인증 방식: 워크스페이스 레벨 JWT(V2_WS_AID 쿠키)를 `flexteam-v2-workspace-access`
 * 헤더로 전달하면, 서버가 해당 법인 스코프의 고객 JWT를 반환한다.
 *
 * @param customerIdHash  법인 식별자. API 바디에는 `customerUuid` 필드로 전달된다.
 * @param userIdHash      해당 법인에서의 사용자 식별자. API 바디에는 `userUuid` 필드로 전달된다.
 */
export async function switchCustomer(
  authCtx: AuthContext,
  baseUrl: string,
  customerIdHash: string,
  userIdHash: string,
): Promise<void> {
  const url = `${baseUrl}/api-public/v2/auth/tokens/customer-user/exchange`;

  // 브라우저 컨텍스트의 실제 쿠키가 진실이다.
  // authHeaders.cookie는 네트워크 요청이 한 번도 없었거나 쿠키가 갱신된 경우 stale일 수 있다.
  const wsAid = await getCookieFromContext(authCtx, baseUrl, "V2_WS_AID");
  if (!wsAid) {
    throw new Error(
      "V2_WS_AID 쿠키를 찾을 수 없습니다. 워크스페이스 인증이 만료되었거나 쿠키가 누락되었습니다.",
    );
  }

  // 브라우저 fetch는 컨텍스트 쿠키를 자동 첨부하므로 Cookie 헤더를 명시할 필요가 없다.
  const exchangeHeaders: Record<string, string> = {
    "content-type": "application/json",
    "flexteam-v2-workspace-access": wsAid,
    "x-flex-axios": "base",
  };

  // API 바디 필드명은 customerUuid/userUuid지만 실제 값은 hash 식별자다
  const body = JSON.stringify({ customerUuid: customerIdHash, userUuid: userIdHash });

  const result = await authCtx.page.evaluate(
    async ([fetchUrl, headers, bodyStr]) => {
      const res = await fetch(fetchUrl, {
        method: "POST",
        headers: headers as Record<string, string>,
        body: bodyStr as string,
        credentials: "include",
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${fetchUrl} — ${errBody.slice(0, 200)}`);
      }
      return (await res.json()) as { token: string };
    },
    [url, exchangeHeaders, body] as const,
  );

  if (!result?.token) {
    throw new Error(`회사 전환 토큰 발급 실패: customerIdHash=${customerIdHash}`);
  }

  authCtx.authHeaders["x-flex-aid"] = result.token;

  // AID 쿠키 jar도 새 JWT로 갱신한다.
  // credentials:"include" fetch는 쿠키 jar의 AID를 자동 첨부하므로, 어떤 이유로
  // 요청에 명시적 x-flex-aid 헤더가 빠져도 쿠키 fallback이 올바른 법인 scope을
  // 유지하게 된다 (defense-in-depth).
  await authCtx.context.addCookies([
    {
      name: "AID",
      value: result.token,
      domain: new URL(baseUrl).hostname,
      path: "/",
    },
  ]);
}

/**
 * 브라우저 컨텍스트에서 지정된 쿠키 값을 읽는다 (httpOnly 쿠키 포함).
 * Playwright의 context.cookies()는 실제 쿠키 저장소를 반환하므로 stale 이슈가 없다.
 */
async function getCookieFromContext(
  authCtx: AuthContext,
  baseUrl: string,
  name: string,
): Promise<string | null> {
  try {
    const cookies = await authCtx.context.cookies(baseUrl);
    const hit = cookies.find((c) => c.name === name);
    if (hit) return hit.value;
  } catch {
    // context.cookies()가 일부 CDP 구성에서 실패할 수 있음 — headers 폴백
  }
  return extractCookieValue(authCtx.authHeaders["cookie"] ?? "", name);
}

function extractCookieValue(cookieStr: string, name: string): string | null {
  for (const pair of cookieStr.split(";")) {
    const trimmed = pair.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}

export async function cleanup(authCtx: AuthContext): Promise<void> {
  try {
    await authCtx.page.close().catch(() => {});
    await authCtx.context.close().catch(() => {});
    await authCtx.browser?.close().catch(() => {});
  } catch {
    // 정리 실패는 무시
  }
}
