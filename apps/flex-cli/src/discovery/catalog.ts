import { readFile } from "node:fs/promises";
import type { ApiCatalog, CatalogEntry } from "../types/catalog.js";
import type { CapturedRequest } from "./traffic-capture.js";
import type { DiscoveredPage } from "./navigator.js";

/** 알려진 엔드포인트 패턴 → 안정적 ID 매핑 */
const ENDPOINT_PATTERNS: Array<{ id: string; method: string; pattern: RegExp }> = [
  { id: "template-list", method: "GET", pattern: /\/api\/v\d+\/approval-document-template\/templates$/ },
  { id: "template-detail", method: "GET", pattern: /\/api\/v\d+\/approval-document-template\/templates\/[^/]+$/ },
  { id: "instance-search", method: "POST", pattern: /\/action\/v\d+\/approval-document\/user-boxes\/search/ },
  { id: "instance-detail", method: "GET", pattern: /\/api\/v\d+\/approval-document\/approval-documents\/[^/]+$/ },
  { id: "time-off-uses", method: "GET", pattern: /\/api\/v\d+\/time-off\/users\/[^/]+\/time-off-uses/ },
  { id: "user-me", method: "GET", pattern: /\/api\/v\d+\/core\/me/ },
];

/** UUID-like 세그먼트를 {param}으로 일반화 */
function generalizeUrlPattern(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/");
  const generalized = segments.map((seg) => {
    // UUID, hash ID, 긴 영숫자 문자열을 {param}으로
    if (/^[a-f0-9-]{20,}$/i.test(seg) || /^[a-zA-Z0-9]{20,}$/.test(seg)) {
      return "{param}";
    }
    return seg;
  });
  return generalized.join("/");
}

/** URL에서 쿼리 파라미터 추출 */
function extractQueryParams(url: string): Record<string, string> | undefined {
  const parsed = new URL(url);
  const params: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return Object.keys(params).length > 0 ? params : undefined;
}

/** 캡처된 요청에 ID를 매칭 */
function matchEndpointId(method: string, url: string): string | null {
  const pathname = new URL(url).pathname;
  for (const pattern of ENDPOINT_PATTERNS) {
    if (pattern.method === method && pattern.pattern.test(pathname)) {
      return pattern.id;
    }
  }
  return null;
}

/** 캡처 결과 + 페이지 정보로 카탈로그 생성 */
export function buildCatalog(
  captures: CapturedRequest[],
  discoveredPages: DiscoveredPage[],
  flexBaseUrl: string,
): ApiCatalog {
  const entries: CatalogEntry[] = [];
  const unclassified: CatalogEntry[] = [];

  for (const capture of captures) {
    const id = matchEndpointId(capture.method, capture.url);
    const urlPattern = generalizeUrlPattern(capture.url);
    const pageInfo = discoveredPages.find((p) =>
      capture.pageUrl.includes(p.url),
    );

    const entry: CatalogEntry = {
      id,
      discoveredFrom: new URL(capture.pageUrl).pathname,
      menuLabel: pageInfo?.menuLabel,
      method: capture.method as CatalogEntry["method"],
      urlPattern,
      exampleUrl: new URL(capture.url).pathname + new URL(capture.url).search,
      queryParams: extractQueryParams(capture.url),
      requestBodySample: capture.requestBody,
      statusCode: capture.statusCode,
      responseBodySample: capture.responseBody,
      totalItems: (capture as CapturedRequest & { totalItems?: number }).totalItems,
      capturedAt: capture.capturedAt,
    };

    if (id) {
      entries.push(entry);
    } else {
      unclassified.push(entry);
    }
  }

  return {
    version: "1.0",
    capturedAt: new Date().toISOString(),
    flexBaseUrl,
    discoveredPages: discoveredPages.map((p) => p.url),
    entries,
    unclassified,
  };
}

/** 파일에서 카탈로그 로드 */
export async function loadCatalog(catalogPath: string): Promise<ApiCatalog | null> {
  try {
    const content = await readFile(catalogPath, "utf-8");
    return JSON.parse(content) as ApiCatalog;
  } catch {
    return null;
  }
}
