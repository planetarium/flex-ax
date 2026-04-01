import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { CrawlerConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export interface AuthContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  authHeaders: Record<string, string>;
}

export async function authenticate(
  config: CrawlerConfig,
  logger: Logger,
): Promise<AuthContext> {
  logger.info("브라우저 시작...");
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  // 내부 API 호출에 재사용할 헤더 수집
  const authHeaders: Record<string, string> = {};

  // 네트워크 요청 인터셉트로 인증 헤더 수집
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

  // 페이지 로드 완료 대기
  await page.waitForLoadState("networkidle");

  // 쿠키에서 인증 정보 추출
  const cookies = await context.cookies();
  if (cookies.length > 0) {
    authHeaders["cookie"] = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  logger.info("로그인 성공", { url: page.url() });
  return { browser, context, page, authHeaders };
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
    await authCtx.browser.close().catch(() => {});
  } catch {
    // 정리 실패는 무시
  }
}
