import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { authenticate, cleanup } from "../auth/index.js";
import { createTrafficCapture } from "../discovery/traffic-capture.js";
import { navigateForDiscovery } from "../discovery/navigator.js";
import { buildCatalog, loadCatalog } from "../discovery/catalog.js";
import { createStorageWriter } from "../storage/index.js";

export async function runDiscover(): Promise<void> {
  const logger = createLogger("DISCOVER");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  // 이전 카탈로그 로드 (diff용)
  const previousCatalog = await loadCatalog(config.catalogPath);

  // 인증
  const authCtx = await authenticate(config, logger);

  try {
    // 트래픽 캡처 시작
    const capture = createTrafficCapture(authCtx.page);
    capture.start();

    // 페이지 탐색
    const discoveredPages = await navigateForDiscovery(authCtx.page, config, logger);

    // 캡처 종료 + 카탈로그 생성
    const captured = capture.stop();
    logger.info(`${captured.length}개 API 요청 캡처됨`);

    const catalog = buildCatalog(captured, discoveredPages, config.flexBaseUrl);

    // 저장
    const storage = createStorageWriter(config.outputDir, config.catalogPath);
    await storage.saveCatalog(catalog);

    // 결과 출력
    console.log(`[FLEX-AX:DISCOVER] 카탈로그 생성 완료: ${config.catalogPath}`);
    console.log(`[FLEX-AX:DISCOVER] entries: ${catalog.entries.length}, unclassified: ${catalog.unclassified.length}, pages: ${discoveredPages.length}`);

    // 이전 카탈로그와 비교
    if (previousCatalog) {
      printDiff(previousCatalog, catalog, logger);
    }

    // 미분류 항목 출력
    if (catalog.unclassified.length > 0) {
      console.log("\n[FLEX-AX:DISCOVER] 미분류 엔드포인트:");
      for (const entry of catalog.unclassified) {
        console.log(`  ${entry.method} ${entry.urlPattern} (from: ${entry.discoveredFrom})`);
      }
    }
  } finally {
    await cleanup(authCtx);
  }
}

function printDiff(
  prev: { entries: Array<{ id: string | null; urlPattern: string }>; unclassified: Array<{ urlPattern: string }> },
  curr: { entries: Array<{ id: string | null; urlPattern: string }>; unclassified: Array<{ urlPattern: string }> },
  logger: ReturnType<typeof createLogger>,
): void {
  const prevIds = new Set(prev.entries.map((e) => e.id).filter(Boolean));
  const currIds = new Set(curr.entries.map((e) => e.id).filter(Boolean));

  const added = [...currIds].filter((id) => !prevIds.has(id));
  const removed = [...prevIds].filter((id) => !currIds.has(id));

  const changed: string[] = [];
  for (const entry of curr.entries) {
    if (!entry.id) continue;
    const prevEntry = prev.entries.find((e) => e.id === entry.id);
    if (prevEntry && prevEntry.urlPattern !== entry.urlPattern) {
      changed.push(`${entry.id}: ${prevEntry.urlPattern} → ${entry.urlPattern}`);
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    logger.info("이전 카탈로그와 변경 없음");
    return;
  }

  console.log("\n[FLEX-AX:DISCOVER] 카탈로그 변경사항:");
  for (const id of added) console.log(`  + 추가: ${id}`);
  for (const id of removed) console.log(`  - 삭제: ${id}`);
  for (const c of changed) console.log(`  ~ 변경: ${c}`);
}
