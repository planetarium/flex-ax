/** API 카탈로그 엔트리 */
export interface CatalogEntry {
  /** 안정적 식별자. 알려진 패턴이면 "template-list" 등, 새 발견이면 null */
  id: string | null;
  /** 발견된 페이지 경로 */
  discoveredFrom: string;
  /** 사이드바 메뉴 라벨 */
  menuLabel?: string;
  /** HTTP 메서드 */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** URL 패턴 (path param은 {param}으로 일반화) */
  urlPattern: string;
  /** 실제 요청 URL 예시 */
  exampleUrl: string;
  /** 쿼리 파라미터 */
  queryParams?: Record<string, string>;
  /** POST 요청 바디 샘플 */
  requestBodySample?: unknown;
  /** HTTP 응답 코드 */
  statusCode: number;
  /** 응답 바디 샘플 (배열은 첫 번째 요소만) */
  responseBodySample?: unknown;
  /** 응답 배열의 총 아이템 수 */
  totalItems?: number;
  /** 캡처 시각 */
  capturedAt: string;
}

/** API 카탈로그 */
export interface ApiCatalog {
  /** 카탈로그 스키마 버전 */
  version: string;
  /** 디스커버리 실행 시각 */
  capturedAt: string;
  /** Flex 기본 URL */
  flexBaseUrl: string;
  /** 디스커버리에서 탐색된 모든 페이지 경로 */
  discoveredPages: string[];
  /** 알려진 엔드포인트 (id가 있는 것) */
  entries: CatalogEntry[];
  /** 새로 발견된 미분류 엔드포인트 (id가 null) */
  unclassified: CatalogEntry[];
}
