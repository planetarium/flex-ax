import type { Page } from "playwright";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

export interface DiscoveredPage {
  url: string;
  menuLabel: string;
}

/** 알려진 페이지 폴백 목록 */
const FALLBACK_PATHS = [
  "/approval/document-box/sent",
  "/approval/admin/templates",
  "/time-tracking/my",
  "/time-off/my",
];

/**
 * flex.team 사이드바 메뉴를 자동으로 순회하며 페이지를 탐색한다.
 * 각 페이지에서 리스트 항목이 있으면 첫 번째 항목을 클릭해서 상세 API도 트리거한다.
 */
export async function navigateForDiscovery(
  page: Page,
  config: Config,
  logger: Logger,
): Promise<DiscoveredPage[]> {
  const discoveredPages: DiscoveredPage[] = [];

  // 메인 페이지 로드
  await page.goto(config.flexBaseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // 사이드바 메뉴 항목 추출 시도
  const baseHost = new URL(config.flexBaseUrl).hostname;
  const menuItems = await extractMenuItems(page, logger, baseHost);

  if (menuItems.length > 0) {
    logger.info(`사이드바에서 ${menuItems.length}개 메뉴 항목 발견`);
    for (const item of menuItems) {
      await visitPage(page, item, config, logger, discoveredPages);
    }
  } else {
    // 폴백: 알려진 URL 직접 방문
    logger.warn("사이드바 메뉴 탐색 실패, 폴백 URL 사용");
    for (const path of FALLBACK_PATHS) {
      await visitPage(
        page,
        { url: `${config.flexBaseUrl}${path}`, label: path },
        config,
        logger,
        discoveredPages,
      );
    }
  }

  return discoveredPages;
}

interface MenuItem {
  url: string;
  label: string;
}

async function extractMenuItems(page: Page, logger: Logger, baseHost: string): Promise<MenuItem[]> {
  try {
    // flex.team의 사이드바 메뉴 링크를 추출
    // 여러 셀렉터를 시도하여 호환성 확보
    const selectors = [
      'nav a[href]',
      '[class*="sidebar"] a[href]',
      '[class*="menu"] a[href]',
      '[class*="nav"] a[href]',
      'aside a[href]',
    ];

    for (const selector of selectors) {
      const items = await page.evaluate((sel) => {
        const links = document.querySelectorAll(sel);
        const results: Array<{ url: string; label: string }> = [];
        const seen = new Set<string>();

        links.forEach((link) => {
          const href = (link as HTMLAnchorElement).href;
          const label = (link as HTMLElement).textContent?.trim() ?? "";
          if (href && label && !seen.has(href) && !href.includes("javascript:")) {
            seen.add(href);
            results.push({ url: href, label });
          }
        });

        return results;
      }, selector);

      if (items.length > 0) {
        logger.info(`셀렉터 '${selector}'로 ${items.length}개 메뉴 발견`);
        // baseHost 내부 링크만 필터 (커스텀/스테이징 도메인 지원)
        return items.filter((item) => {
          try {
            return new URL(item.url).hostname === baseHost;
          } catch {
            return false;
          }
        });
      }
    }
  } catch (error) {
    logger.warn("메뉴 항목 추출 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return [];
}

async function visitPage(
  page: Page,
  target: MenuItem,
  config: Config,
  logger: Logger,
  discoveredPages: DiscoveredPage[],
): Promise<void> {
  try {
    logger.info(`페이지 탐색: ${target.label} (${target.url})`);

    await page.goto(target.url, { waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(2000);

    discoveredPages.push({
      url: new URL(page.url()).pathname,
      menuLabel: target.label,
    });

    // 리스트 페이지에서 첫 번째 항목 클릭 시도 (상세 API 트리거)
    await tryClickFirstListItem(page, logger);

    // 요청 간 딜레이
    await page.waitForTimeout(config.requestDelayMs);
  } catch (error) {
    logger.warn(`페이지 탐색 실패: ${target.label}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function tryClickFirstListItem(page: Page, logger: Logger): Promise<void> {
  try {
    // 리스트 항목의 일반적인 셀렉터
    const listSelectors = [
      'table tbody tr:first-child',
      '[class*="list"] [class*="item"]:first-child',
      '[class*="row"]:first-child a',
      '[role="row"]:first-child',
    ];

    for (const selector of listSelectors) {
      const element = page.locator(selector).first();
      if (await element.isVisible({ timeout: 2000 }).catch(() => false)) {
        await element.click();
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(2000);

        // 뒤로 가기
        await page.goBack({ waitUntil: "networkidle" }).catch(() => {});
        await page.waitForTimeout(1000);

        logger.info("리스트 항목 클릭 → 상세 페이지 API 캡처");
        return;
      }
    }
  } catch {
    // 클릭 실패는 무시 — 리스트가 없는 페이지일 수 있음
  }
}
