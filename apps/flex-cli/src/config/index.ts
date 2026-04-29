import { z } from "zod";

const configSchema = z.object({
  flexEmail: z.string().min(1, "FLEX_EMAIL is required"),
  /**
   * env에 비밀번호가 직접 들어있으면 우선 사용한다.
   * 비어있으면 OS 키링 → 대화형 프롬프트 순으로 fallback (auth/credentials.ts).
   */
  flexPassword: z.string().default(""),
  flexBaseUrl: z.string().url().default("https://flex.team"),
  outputDir: z.string().default("./output"),
  catalogPath: z.string().default("./output/api-catalog.json"),
  requestDelayMs: z.coerce.number().int().min(0).default(1000),
  maxRetries: z.coerce.number().int().min(0).default(3),
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
  return configSchema.parse({
    flexEmail: process.env.FLEX_EMAIL,
    flexPassword: process.env.FLEX_PASSWORD,
    flexBaseUrl: process.env.FLEX_BASE_URL || undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    catalogPath: process.env.CATALOG_PATH || undefined,
    requestDelayMs: process.env.REQUEST_DELAY_MS || undefined,
    maxRetries: process.env.MAX_RETRIES || undefined,
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS || undefined,
    crawlSensitive: process.env.FLEX_CRAWL_SENSITIVE || undefined,
    skipEndpoints: process.env.FLEX_SKIP_ENDPOINTS || undefined,
    customers: process.env.FLEX_CUSTOMERS || undefined,
  });
}
