import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { CrawlerConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export interface AuthContext {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  authHeaders: Record<string, string>;
}

export async function authenticate(
  config: CrawlerConfig,
  logger: Logger,
): Promise<AuthContext> {
  if (config.authMode === "sso") {
    return authenticateSSO(config, logger);
  }
  return authenticateCredentials(config, logger);
}

async function launchBrowser(
  config: CrawlerConfig,
): Promise<{ browser: Browser; context: BrowserContext; page: Page; authHeaders: Record<string, string> }> {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  const authHeaders: Record<string, string> = {};

  const baseHostname = new URL(config.flexBaseUrl).hostname;
  page.on("request", (request) => {
    const url = request.url();
    try {
      const reqHostname = new URL(url).hostname;
      if (reqHostname === baseHostname && url.includes("/api/")) {
        const headers = request.headers();
        for (const key of ["authorization", "cookie", "x-csrf-token"]) {
          if (headers[key]) {
            authHeaders[key] = headers[key];
          }
        }
      }
    } catch {
      // invalid URL, skip
    }
  });

  return { browser, context, page, authHeaders };
}

async function collectCookies(
  context: BrowserContext,
  authHeaders: Record<string, string>,
): Promise<void> {
  const cookies = await context.cookies();
  if (cookies.length > 0) {
    authHeaders["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

async function authenticateCredentials(
  config: CrawlerConfig,
  logger: Logger,
): Promise<AuthContext> {
  logger.info("브라우저 시작...");
  const { browser, context, page, authHeaders } = await launchBrowser(config);

  logger.info("flex 로그인 페이지 이동...");
  await page.goto(`${config.flexBaseUrl}/login`, { waitUntil: "networkidle" });

  // Step 1: 이메일 입력 후 Enter (다음 단계 전환)
  logger.info("이메일 입력...");
  const emailInput = page.locator('input[type="email"]');
  await emailInput.fill(config.flexEmail);
  await emailInput.press("Enter");

  // Step 2: 비밀번호 필드 나타남 → 입력 → 로그인하기 클릭
  logger.info("비밀번호 입력...");
  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 10000 });
  await passwordInput.fill(config.flexPassword);
  await page.locator('button[type="submit"]').click();

  // 로그인 완료 대기
  logger.info("로그인 완료 대기...");
  await page.waitForURL((url) => !url.toString().includes("/auth/login"), {
    timeout: 30000,
  });

  await page.waitForLoadState("networkidle");
  await collectCookies(context, authHeaders);

  logger.info("로그인 성공", { url: page.url() });
  return { browser, context, page, authHeaders };
}

async function authenticateSSO(
  config: CrawlerConfig,
  logger: Logger,
): Promise<AuthContext> {
  const userDataDir = config.chromeUserDataDir || getDefaultChromeUserDataDir();
  logger.info("SSO 모드: 기존 Chrome 프로필의 세션을 사용합니다.", { userDataDir });

  const authHeaders: Record<string, string> = {};
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // SSO 모드에서는 항상 브라우저 표시
    channel: "chrome", // 설치된 Chrome 사용
  });

  const page = context.pages()[0] ?? await context.newPage();

  const ssoHostname = new URL(config.flexBaseUrl).hostname;
  page.on("request", (request) => {
    const url = request.url();
    try {
      const reqHostname = new URL(url).hostname;
      if (reqHostname === ssoHostname && url.includes("/api/")) {
        const headers = request.headers();
        for (const key of ["authorization", "cookie", "x-csrf-token"]) {
          if (headers[key]) {
            authHeaders[key] = headers[key];
          }
        }
      }
    } catch { /* skip */ }
  });

  // flex.team으로 이동 — 이미 로그인되어 있으면 바로 대시보드로 감
  await page.goto(`${config.flexBaseUrl}`, { waitUntil: "networkidle" });

  // 로그인 페이지로 리다이렉트된 경우 수동 로그인 대기
  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth/") || currentUrl.includes("accounts.google.com")) {
    logger.info("로그인이 필요합니다. 브라우저에서 로그인을 완료해 주세요. (최대 5분 대기)");
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
  }

  await page.waitForLoadState("networkidle");
  await collectCookies(context, authHeaders);

  logger.info("SSO 로그인 성공", { url: page.url() });

  return { browser: context.browser(), context, page, authHeaders };
}

function getDefaultChromeUserDataDir(): string {
  const platform = process.platform;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (platform === "darwin") {
    return `${home}/Library/Application Support/Google/Chrome`;
  }
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
      ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local` : undefined);
    if (!localAppData) {
      throw new Error(
        "Chrome 사용자 데이터 디렉터리를 확인할 수 없습니다. CHROME_USER_DATA_DIR 환경 변수를 설정해 주세요.",
      );
    }
    return `${localAppData}\\Google\\Chrome\\User Data`;
  }
  // linux
  return `${home}/.config/google-chrome`;
}

export async function ensureAuthenticated(
  authCtx: AuthContext,
  config: CrawlerConfig,
  logger: Logger,
): Promise<void> {
  try {
    // 간단한 API 호출로 세션 유효성 확인
    const response = await authCtx.page.goto(`${config.flexBaseUrl}/api/v2/core/me`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    if (response && response.status() === 401) {
      logger.warn("세션 만료 감지, 재인증 시도...");
      await cleanup(authCtx);
      const newCtx = await authenticate(config, logger);
      authCtx.browser = newCtx.browser;
      authCtx.context = newCtx.context;
      authCtx.page = newCtx.page;
      authCtx.authHeaders = newCtx.authHeaders;
    }
  } catch {
    logger.warn("세션 확인 실패, 재인증 시도...");
    await cleanup(authCtx);
    const newCtx = await authenticate(config, logger);
    authCtx.browser = newCtx.browser;
    authCtx.context = newCtx.context;
    authCtx.page = newCtx.page;
    authCtx.authHeaders = newCtx.authHeaders;
  }
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
