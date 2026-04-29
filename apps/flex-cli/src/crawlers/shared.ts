import type { CrawlError } from "../types/common.js";
import { type AuthContext, apiHeaders } from "../auth/index.js";
import type { ApiCatalog, CatalogEntry } from "../types/catalog.js";

/** 수집 결과 */
export interface CrawlResult {
  totalCount: number;
  successCount: number;
  failureCount: number;
  errors: CrawlError[];
  durationMs: number;
}

/** 페이지네이션 헬퍼 */
export async function paginatedFetch<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  options: {
    delayMs: number;
    maxRetries: number;
    onItem: (item: T) => Promise<void>;
  },
): Promise<void> {
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await withRetry(() => fetchPage(page), {
      maxRetries: options.maxRetries,
      delayMs: options.delayMs,
    });

    for (const item of result.items) {
      await options.onItem(item);
    }

    hasMore = result.hasMore;
    page++;

    if (hasMore) {
      await delay(options.delayMs);
    }
  }
}

/** 재시도 래퍼 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    delayMs: number;
    shouldRetry?: (error: unknown) => boolean;
  },
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (options.shouldRetry && !options.shouldRetry(error)) {
        throw error;
      }

      if (attempt < options.maxRetries) {
        const backoff = options.delayMs * Math.pow(2, attempt);
        await delay(backoff);
      }
    }
  }

  throw lastError;
}

/** 요청 간 딜레이 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 현재 시각 ISO 문자열 */
export function nowISO(): string {
  return new Date().toISOString();
}

/** CrawlResult 초기값 생성 */
export function emptyCrawlResult(): CrawlResult {
  return {
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    durationMs: 0,
  };
}

/** 인증 토큰을 실어 flex API GET 호출 */
export async function flexFetch<T>(authCtx: AuthContext, url: string): Promise<T> {
  const res = await fetch(url, { headers: apiHeaders(authCtx) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${url}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/** 인증 토큰을 실어 flex API POST 호출 */
export async function flexPost<T>(authCtx: AuthContext, url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: apiHeaders(authCtx),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${url}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

/**
 * 카탈로그에서 엔드포인트를 조회한다.
 * 카탈로그가 없거나 엔드포인트가 없으면 null 반환.
 */
export function resolveEndpoint(
  catalog: ApiCatalog | null,
  endpointId: string,
): CatalogEntry | null {
  if (!catalog) return null;
  return catalog.entries.find((e) => e.id === endpointId) ?? null;
}

/**
 * 카탈로그에서 엔드포인트 URL을 조회하거나, 없으면 폴백 URL 반환.
 */
export function resolveUrl(
  baseUrl: string,
  catalog: ApiCatalog | null,
  endpointId: string,
  fallbackPath: string,
): string {
  const entry = resolveEndpoint(catalog, endpointId);
  return entry ? `${baseUrl}${entry.urlPattern}` : `${baseUrl}${fallbackPath}`;
}
