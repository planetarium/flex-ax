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
  /**
   * withRetry가 실제로 발사한 재시도 횟수 합계. 초기 시도는 포함하지 않으며
   * (n번 재시도 = n+1번 호출), 최종 성공/실패 여부와 무관하게 누적된다.
   * crawl-report.json에서 throttling/네트워크 불안정 신호로 활용.
   */
  retries: number;
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

/** HTTP 응답 코드를 그대로 가지고 있는 에러 — 429 백오프에 사용. */
export class FlexHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}: ${url}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "FlexHttpError";
  }
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** 재시도 래퍼 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    delayMs: number;
    shouldRetry?: (error: unknown) => boolean;
    /**
     * 다음 재시도 직전에 1회 호출된다. attempt는 0-base로 직전 실패한 시도의
     * 인덱스(즉 곧 발사할 재시도는 attempt+1번째 호출). 호출자가 재시도 횟수를
     * 누적하려면 이 콜백에서 카운터를 올리면 된다.
     */
    onRetry?: (attempt: number, error: unknown) => void;
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
        options.onRetry?.(attempt, error);
        const retryAfter =
          error instanceof FlexHttpError && error.status === 429 ? error.retryAfterMs : undefined;
        const baseDelay = options.delayMs > 0 ? options.delayMs : 250;
        const backoff = retryAfter ?? baseDelay * Math.pow(2, attempt);
        await delay(backoff);
      }
    }
  }

  throw lastError;
}

/**
 * 동시 N개로 작업을 처리하는 단순 워커풀.
 * 입력 순서를 보존하지 않고, 각 항목별 결과를 그대로 반환한다.
 */
export async function pooledMap<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function runner(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => runner()));
  return results;
}

/** 요청 간 딜레이 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 현재 시각 ISO 문자열 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * candidate가 baseline보다 시간상 더 늦은지 epoch ms로 비교한다. ISO 8601
 * 사전식 비교는 `...00Z` vs `...00.500Z` 같이 밀리초 포함/미포함이 섞이면
 * 시간 순서를 보장하지 않으므로 max 선택용으로 쓰면 안 된다.
 *
 * 잘못된 포맷:
 *   - candidate가 invalid 또는 빈 문자열 → false (절대 baseline을 대체하지 않음)
 *   - baseline이 invalid 또는 null → candidate가 valid이기만 하면 true
 */
export function isLaterIso(
  candidate: string | null | undefined,
  baseline: string | null | undefined,
): boolean {
  if (!candidate) return false;
  const a = Date.parse(candidate);
  if (!Number.isFinite(a)) return false;
  if (!baseline) return true;
  const b = Date.parse(baseline);
  if (!Number.isFinite(b)) return true;
  return a > b;
}

/**
 * KST(Asia/Seoul) 기준 YYYY-MM-DD 문자열로 변환한다.
 *
 * flex.team의 `lastUpdatedDateRange` 필터는 timestamp가 아니라 date 단위로
 * 동작하며 워크스페이스 timezone 기준으로 해석되는 것으로 보인다(2026-05-04
 * 캡처). 한국 워크스페이스 운영을 가정해 KST로 정규화한다. `sv-SE` 로케일은
 * `YYYY-MM-DD` 형식을 그대로 반환하므로 패딩 처리가 불필요하다.
 */
export function toKstDate(d: Date | string | number): string {
  const date = typeof d === "object" ? d : new Date(d);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(date);
}

/** CrawlResult 초기값 생성 */
export function emptyCrawlResult(): CrawlResult {
  return {
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    durationMs: 0,
    retries: 0,
  };
}

/** 인증 토큰을 실어 flex API GET 호출 */
export async function flexFetch<T>(authCtx: AuthContext, url: string): Promise<T> {
  const res = await fetch(url, { headers: apiHeaders(authCtx) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FlexHttpError(res.status, url, body, parseRetryAfter(res.headers.get("retry-after")));
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
    throw new FlexHttpError(res.status, url, text, parseRetryAfter(res.headers.get("retry-after")));
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
