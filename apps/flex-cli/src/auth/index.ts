import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export interface AuthContext {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  authHeaders: Record<string, string>;
}

export async function authenticate(
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  if (config.authMode === "sso") {
    return authenticateSSO(config, logger);
  }
  return authenticateCredentials(config, logger);
}

function setupHeaderCapture(
  page: Page,
  authHeaders: Record<string, string>,
): void {
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("flex.team") && url.includes("/api/")) {
      const headers = request.headers();
      for (const key of ["authorization", "cookie", "x-csrf-token"]) {
        if (headers[key]) {
          authHeaders[key] = headers[key];
        }
      }
    }
  });
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
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  logger.info("브라우저 시작...");
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  const authHeaders: Record<string, string> = {};
  setupHeaderCapture(page, authHeaders);

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
  await collectCookies(context, authHeaders);

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
  setupHeaderCapture(page, authHeaders);

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
  await collectCookies(context, authHeaders);

  console.log("[FLEX-AX:AUTH] 로그인 성공");
  return { browser, context, page, authHeaders };
}

function getDefaultChromeUserDataDir(): string {
  const platform = process.platform;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (platform === "darwin") {
    return `${home}/Library/Application Support/Google/Chrome`;
  }
  if (platform === "win32") {
    return `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`;
  }
  return `${home}/.config/google-chrome`;
}

export async function ensureAuthenticated(
  authCtx: AuthContext,
  config: Config,
  logger: Logger,
): Promise<void> {
  try {
    const response = await authCtx.page.goto(`${config.flexBaseUrl}/api/v2/core/me`, {
      waitUntil: "domcontentloaded",
      timeout: 10000,
    });

    if (response && response.status() === 401) {
      logger.warn("세션 만료 감지, 재인증 시도...");
      await cleanup(authCtx);
      const newCtx = await authenticate(config, logger);
      Object.assign(authCtx, newCtx);
    }
  } catch {
    logger.warn("세션 확인 실패, 재인증 시도...");
    await cleanup(authCtx);
    const newCtx = await authenticate(config, logger);
    Object.assign(authCtx, newCtx);
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
