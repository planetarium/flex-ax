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
  /** 배열 응답의 원본 길이 (truncate 전) */
  totalItems?: number;
  capturedAt: string;
}

const SKIP_PATTERNS = [
  /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)(\?|$)/i,
  /analytics/i,
  // `/time-tracking/...` 같은 비즈니스 API와 충돌하지 않도록 좁힌다 (예: /pixel-tracking/, /event-tracking/)
  /\/(pixel|event|user|click|conversion)-?tracking(\/|\?|$)/i,
  /sentry/i,
  /hotjar/i,
  /gtag/i,
  /google-analytics/i,
  /googletagmanager/i,
];

function isApiUrl(url: string): boolean {
  // `/api/`, `/action/`, `/remotes/` 경로를 API 호출로 간주한다.
  // catalog.ts의 ENDPOINT_PATTERNS에 `/remotes/gnb/...`, `/remotes/user-profile/...`
  // 같은 프론트엔드 BFF 경로가 포함되어 있어 캡처 대상에 포함해야 한다.
  const isApi =
    url.includes("/api/") ||
    url.includes("/action/") ||
    url.includes("/remotes/");
  return isApi && !SKIP_PATTERNS.some((p) => p.test(url));
}

/**
 * pathname의 ID-like 세그먼트를 placeholder로 치환한다.
 * - 긴 영숫자/헥스/대시 문자열(20자 이상) → {id}
 * - 순수 숫자 세그먼트 → {id}
 * - 숫자 범위 표현(예: `1767193200000..1798729200000`) → {range}
 *
 * discover 시 중복 제거 키와 catalog의 urlPattern 생성에 공용으로 쓰인다.
 */
export function normalizeUrlPath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^[a-f0-9-]{20,}$/i.test(seg)) return "{id}";
      if (/^[a-zA-Z0-9]{20,}$/.test(seg)) return "{id}";
      if (/^\d+$/.test(seg)) return "{id}";
      if (/^\d+\.\.\d+$/.test(seg)) return "{range}";
      return seg;
    })
    .join("/");
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
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const { truncated } = truncateResponse(value, depth + 1);
      result[key] = truncated;
    }
    // totalItems는 최상위가 배열인 경우에만 의미가 있으므로 object 분기에서는 전파하지 않는다
    return { truncated: result };
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
      // idempotent: 이미 등록된 handler가 있으면 먼저 제거하여 중복 캡처/리스너 누수를 방지한다.
      // captured/seenPatterns도 함께 초기화하여 새 세션을 시작한다.
      if (handler) {
        page.removeListener("response", handler);
        handler = null;
      }
      captured.length = 0;
      seenPatterns.clear();
      handler = async (response: Response) => {
        const url = response.url();
        if (!isApiUrl(url)) return;

        const method = response.request().method();
        // 중복 방지: 같은 method + URL 패턴(ID 세그먼트 일반화)은 한 번만 캡처
        const urlPath = new URL(url).pathname;
        const patternKey = `${method}:${normalizeUrlPath(urlPath)}`;
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
          });
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
