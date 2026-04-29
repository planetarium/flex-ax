import "dotenv/config";
import { z } from "zod";
import { loadGlobalConfig } from "./global-config.js";

const configSchema = z.object({
  /**
   * env(FLEX_EMAIL) 우선, 없으면 ~/.flex-ax/config.json 의 email.
   * 둘 다 비면 authenticate에서 명시적으로 에러 처리.
   */
  flexEmail: z.string().default(""),
  /**
   * env에 비밀번호가 직접 들어있으면 우선 사용한다.
   * 비어있으면 OS 키링 → 대화형 프롬프트 순으로 fallback (auth/credentials.ts).
   */
  flexPassword: z.string().default(""),
  flexBaseUrl: z.string().url().default("https://flex.team"),
  outputDir: z.string().default("./output"),
  /**
   * 요청 간 의도적 sleep. 동시성으로 throttling을 대체하므로 기본 0.
   * 외부 환경(공유 IP 풀 등)에서 보수적으로 돌릴 일이 있으면 env로 올린다.
   */
  requestDelayMs: z.coerce.number().int().min(0).default(0),
  maxRetries: z.coerce.number().int().min(0).default(3),
  /**
   * 인스턴스/템플릿 상세 fetch 동시 워커 수.
   * probe 실측: 32까지 429 0건, 64에서 throughput 정점, 96부터 latency 증가.
   * 안전 마진 두고 16을 기본값으로 사용.
   */
  concurrency: z.coerce.number().int().min(1).default(16),
  /** 한 문서의 첨부파일 다운로드 동시 수. */
  attachmentConcurrency: z.coerce.number().int().min(1).default(4),
  /**
   * approval-document 검색 page size.
   * 이 엔드포인트는 lastDocumentKey 페이지네이션이 동작하지 않아서
   * 한 번에 다 받는다. 기본 1000이면 대부분 테넌트는 한 방에 끝.
   */
  searchPageSize: z.coerce.number().int().min(1).default(1000),
  downloadAttachments: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
});

export type CrawlerConfig = z.infer<typeof configSchema>;

export function loadConfig(): CrawlerConfig {
  const global = loadGlobalConfig();
  return configSchema.parse({
    flexEmail: process.env.FLEX_EMAIL || global.email || undefined,
    flexPassword: process.env.FLEX_PASSWORD,
    flexBaseUrl: process.env.FLEX_BASE_URL || undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    requestDelayMs: process.env.REQUEST_DELAY_MS || undefined,
    maxRetries: process.env.MAX_RETRIES || undefined,
    concurrency: process.env.CONCURRENCY || undefined,
    attachmentConcurrency: process.env.ATTACHMENT_CONCURRENCY || undefined,
    searchPageSize: process.env.SEARCH_PAGE_SIZE || undefined,
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS || undefined,
  });
}
