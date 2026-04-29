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
  requestDelayMs: z.coerce.number().int().min(0).default(1000),
  maxRetries: z.coerce.number().int().min(0).default(3),
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
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS || undefined,
  });
}
