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
        for (const key of ["authorization", "cookie", "x-csrf-token", "x-flex-aid", "x-flex-axios"]) {
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

  const cookieStr = await remotePage.evaluate(() => document.cookie);

  // CDP 연결 해제 (사용자 브라우저는 닫지 않음)
  remoteBrowser.close().catch(() => {});

  if (!cookieStr) {
    throw new Error(
      "Playwriter에서 쿠키를 가져올 수 없습니다. " +
      "Chrome에서 flex.team에 로그인되어 있는지 확인하세요.",
    );
  }

  const parsedCookies = cookieStr.split(";").map((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return {
      name: name.trim(),
      value: rest.join("="),
      domain: new URL(config.flexBaseUrl).hostname,
      path: "/",
    };
  }).filter((c) => c.name && c.value);

  logger.info(`쿠키 ${parsedCookies.length}개 확보`);

  // 3. headless 브라우저에 쿠키 주입
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(parsedCookies);

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
 */
export async function switchCustomer(
  authCtx: AuthContext,
  baseUrl: string,
  customerUuid: string,
  userUuid: string,
): Promise<void> {
  const url = `${baseUrl}/api-public/v2/auth/tokens/customer-user/exchange`;
  const wsAid = extractCookieValue(authCtx.authHeaders["cookie"] ?? "", "V2_WS_AID");
  if (!wsAid) {
    throw new Error(
      "V2_WS_AID 쿠키를 찾을 수 없습니다. 워크스페이스 인증이 만료되었거나 쿠키가 누락되었습니다.",
    );
  }

  const exchangeHeaders: Record<string, string> = {
    cookie: authCtx.authHeaders["cookie"] ?? "",
    "content-type": "application/json",
    "flexteam-v2-workspace-access": wsAid,
    "x-flex-axios": "base",
  };

  const result = await authCtx.page.evaluate(
    async ([fetchUrl, headers, bodyStr]) => {
      const res = await fetch(fetchUrl, {
        method: "POST",
        headers: headers as Record<string, string>,
        body: bodyStr as string,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${fetchUrl} — ${body.slice(0, 200)}`);
      }
      return (await res.json()) as { token: string };
    },
    [url, exchangeHeaders, JSON.stringify({ customerUuid, userUuid })] as const,
  );

  if (!result?.token) {
    throw new Error(`회사 전환 토큰 발급 실패: customerUuid=${customerUuid}`);
  }

  authCtx.authHeaders["x-flex-aid"] = result.token;
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
