import { z } from "zod";
import { loadGlobalConfig } from "./global-config.js";

const configSchema = z.object({
  /**
   * env(FLEX_EMAIL)에 직접 있으면 우선. 비어있으면 ~/.flex-ax/config.json 의 email 사용.
   * 둘 다 비면 빈 문자열 — authenticate에서 명시적으로 에러 처리한다 (login 명령은 빈 값에서
   * 프롬프트로 분기 가능해야 하므로 schema 레벨에서 강제하지 않는다).
   */
  flexEmail: z.string().default(""),
  /**
   * env에 비밀번호가 직접 들어있으면 우선 사용한다.
   * 비어있으면 OS 키링 → 대화형 프롬프트 순으로 fallback (auth/credentials.ts).
   */
  flexPassword: z.string().default(""),
  flexBaseUrl: z.string().url().default("https://flex.team"),
  outputDir: z.string().default("./output"),
  catalogPath: z.string().default("./output/api-catalog.json"),
  /**
   * 요청 간 의도적 sleep. 동시성으로 throttling을 대체하므로 기본 0.
   * 외부 환경(공유 IP 풀 등)에서 보수적으로 돌릴 일이 있으면 env로 올린다.
   */
  requestDelayMs: z.coerce.number().int().min(0).default(0),
  maxRetries: z.coerce.number().int().min(0).default(3),
  /**
   * 인스턴스/템플릿 상세 fetch 동시 워커 수.
   * probe 실측: c=32까지 429 0건, c=64에서 throughput 정점, c=96+ 부터 latency 증가.
   * 안전 마진을 두고 16을 기본값으로 사용.
   */
  concurrency: z.coerce.number().int().min(1).default(16),
  /** 한 문서의 첨부파일 다운로드 동시 수. */
  attachmentConcurrency: z.coerce.number().int().min(1).default(4),
  /**
   * approval-document 검색 1회 호출의 size.
   * 이 endpoint의 cursor 페이지네이션이 신뢰할 수 없게 동작하는 케이스가 있어
   * size를 키우면 한 번에 끝나는 경우가 많다. 초과 시 경고를 띄운다.
   */
  searchPageSize: z.coerce.number().int().min(1).default(1000),
  downloadAttachments: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
  /** 민감 엔드포인트(연봉/계약/개인정보)를 크롤링할지 여부. 기본은 false — 스킵됨 */
  crawlSensitive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("false"),
  /** 콤마로 구분된 추가 스킵 엔드포인트 id 목록 */
  skipEndpoints: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  /**
   * 크롤링할 법인(customerIdHash) 목록. 콤마 구분.
   * 비어있으면 사용자가 속한 모든 법인을 대상으로 한다.
   */
  customers: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const global = loadGlobalConfig();
  return configSchema.parse({
    flexEmail: process.env.FLEX_EMAIL || global.email || undefined,
    flexPassword: process.env.FLEX_PASSWORD,
    flexBaseUrl: process.env.FLEX_BASE_URL || undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    catalogPath: process.env.CATALOG_PATH || undefined,
    requestDelayMs: process.env.REQUEST_DELAY_MS || undefined,
    maxRetries: process.env.MAX_RETRIES || undefined,
    concurrency: process.env.CONCURRENCY || undefined,
    attachmentConcurrency: process.env.ATTACHMENT_CONCURRENCY || undefined,
    searchPageSize: process.env.SEARCH_PAGE_SIZE || undefined,
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS || undefined,
    crawlSensitive: process.env.FLEX_CRAWL_SENSITIVE || undefined,
    skipEndpoints: process.env.FLEX_SKIP_ENDPOINTS || undefined,
    customers: process.env.FLEX_CUSTOMERS || undefined,
  });
}
