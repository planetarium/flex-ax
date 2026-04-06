import { execFileSync } from "node:child_process";
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
  await collectCookies(context, authHeaders);

  console.log("[FLEX-AX:AUTH] 로그인 성공");
  return { browser, context, page, authHeaders };
}

async function authenticatePlaywriter(
  config: Config,
  logger: Logger,
): Promise<AuthContext> {
  logger.info("Playwriter 모드: 기존 Chrome 세션에서 쿠키를 가져옵니다.");

  // 1. Playwriter 세션 확보 (기존 세션 ID 또는 새로 생성)
  let sessionId = config.playwriterSession;
  if (!sessionId) {
    logger.info("Playwriter 세션 생성 중...");
    const output = execFileSync("playwriter", ["session", "new"], {
      encoding: "utf-8",
      timeout: 30000,
    });
    const match = output.match(/Session\s+(\S+)\s+created/);
    if (!match) {
      throw new Error(`Playwriter 세션 생성 실패: ${output}`);
    }
    sessionId = match[1];
    logger.info(`Playwriter 세션: ${sessionId}`);
  }

  // 2. Playwriter로 이동 + 쿠키 추출
  // sessionId 검증 (영数字/ハイフンのみ)
  if (!/^[\w-]+$/.test(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  const safeFlexBaseUrl = JSON.stringify(config.flexBaseUrl);
  const cookieScript = `await page.goto(${safeFlexBaseUrl}); const cookies = await page.evaluate(() => document.cookie); return cookies;`;
  const rawOutput = execFileSync("playwriter", [
    "-s", sessionId,
    "--timeout", "30000",
    "-e", cookieScript,
  ], { encoding: "utf-8", timeout: 40000 });
  const cookieStr = rawOutput.replace("[return value] ", "").trim();

  if (!cookieStr) {
    throw new Error("Playwriter에서 쿠키를 가져올 수 없습니다. Chrome에서 flex.team에 로그인되어 있는지 확인하세요.");
  }

  logger.info(`쿠키 ${cookieStr.split(";").length}개 확보`);

  // 3. headless 브라우저에 쿠키 주입
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // document.cookie 문자열을 파싱하여 Playwright 쿠키로 변환
  const parsedCookies = cookieStr.split(";").map((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return {
      name: name.trim(),
      value: rest.join("="),
      domain: new URL(config.flexBaseUrl).hostname,
      path: "/",
    };
  }).filter((c) => c.name && c.value);

  await context.addCookies(parsedCookies);

  const page = await context.newPage();
  const authHeaders: Record<string, string> = {
    cookie: cookieStr,
  };
  setupHeaderCapture(page, authHeaders, config.flexBaseUrl);

  // 4. 쿠키가 유효한지 확인
  await page.goto(config.flexBaseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

  const currentUrl = page.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/auth/")) {
    await cleanup({ browser, context, page, authHeaders });
    throw new Error("Playwriter에서 가져온 쿠키가 만료되었습니다. Chrome에서 flex.team에 다시 로그인하세요.");
  }

  console.log("[FLEX-AX:AUTH] Playwriter 세션으로 로그인 성공");
  return { browser, context, page, authHeaders };
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
