import type { CrawlError } from "../types/common.js";
import { type AuthContext, apiHeaders } from "../auth/index.js";

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
        // 429 응답에 Retry-After가 있으면 그 값을 우선 사용한다.
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

/** 인증 토큰을 실어 flex API GET 호출 */
export async function flexFetch<T>(authCtx: AuthContext, url: string): Promise<T> {
  const res = await fetch(url, { headers: apiHeaders(authCtx) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FlexHttpError(res.status, url, text, parseRetryAfter(res.headers.get("retry-after")));
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
