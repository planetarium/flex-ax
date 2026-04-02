import type { Page, Response } from "playwright";

/** 캡처된 API 요청/응답 */
export interface CapturedRequest {
  url: string;
  method: string;
  /** 요청 발생 시점의 페이지 URL */
  pageUrl: string;
  requestBody?: unknown;
  statusCode: number;
  responseBody?: unknown;
  capturedAt: string;
}

const SKIP_PATTERNS = [
  /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)(\?|$)/i,
  /analytics/i,
  /tracking/i,
  /sentry/i,
  /hotjar/i,
  /gtag/i,
  /google-analytics/i,
  /googletagmanager/i,
];

function isApiUrl(url: string): boolean {
  return (url.includes("/api/") || url.includes("/action/")) &&
    !SKIP_PATTERNS.some((p) => p.test(url));
}

/**
 * 응답 바디를 간결하게 만든다.
 * - 배열: 첫 번째 요소만 남기고 totalItems 반환
 * - 깊이 제한
 */
function truncateResponse(body: unknown, depth = 0): { truncated: unknown; totalItems?: number } {
  if (depth > 5) return { truncated: "[TRUNCATED]" };

  if (Array.isArray(body)) {
    const totalItems = body.length;
    const first = body.length > 0 ? truncateResponse(body[0], depth + 1).truncated : undefined;
    return { truncated: first !== undefined ? [first] : [], totalItems };
  }

  if (body && typeof body === "object") {
    const result: Record<string, unknown> = {};
    let itemCount: number | undefined;

    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const { truncated, totalItems } = truncateResponse(value, depth + 1);
      result[key] = truncated;
      if (totalItems !== undefined) {
        itemCount = totalItems;
      }
    }
    return { truncated: result, totalItems: itemCount };
  }

  return { truncated: body };
}

export interface TrafficCapture {
  start(): void;
  stop(): CapturedRequest[];
}

export function createTrafficCapture(page: Page): TrafficCapture {
  const captured: CapturedRequest[] = [];
  const seenPatterns = new Set<string>();
  let handler: ((response: Response) => Promise<void>) | null = null;

  return {
    start() {
      handler = async (response: Response) => {
        const url = response.url();
        if (!isApiUrl(url)) return;

        const method = response.request().method();
        // 중복 방지: 같은 method + URL path 패턴은 한 번만 캡처
        const urlPath = new URL(url).pathname;
        const patternKey = `${method}:${urlPath}`;
        if (seenPatterns.has(patternKey)) return;
        seenPatterns.add(patternKey);

        try {
          const statusCode = response.status();
          let responseBody: unknown;
          try {
            responseBody = await response.json();
          } catch {
            // JSON이 아닌 응답은 무시
            return;
          }

          let requestBody: unknown;
          if (method === "POST" || method === "PUT" || method === "PATCH") {
            try {
              requestBody = JSON.parse(response.request().postData() ?? "");
            } catch {
              // 파싱 실패 무시
            }
          }

          const { truncated, totalItems } = truncateResponse(responseBody);

          captured.push({
            url,
            method,
            pageUrl: page.url(),
            requestBody,
            statusCode,
            responseBody: truncated,
            ...(totalItems !== undefined ? { totalItems } : {}),
            capturedAt: new Date().toISOString(),
          } as CapturedRequest & { totalItems?: number });
        } catch {
          // 캡처 실패는 무시
        }
      };

      page.on("response", handler);
    },

    stop() {
      if (handler) {
        page.removeListener("response", handler);
        handler = null;
      }
      return [...captured];
    },
  };
}
