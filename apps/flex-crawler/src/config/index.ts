import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  flexEmail: z.string().min(1, "FLEX_EMAIL is required"),
  flexPassword: z.string().min(1, "FLEX_PASSWORD is required"),
  flexBaseUrl: z.string().url().default("https://flex.team"),
  outputDir: z.string().default("./output"),
  requestDelayMs: z.coerce.number().int().min(0).default(1000),
  maxRetries: z.coerce.number().int().min(0).default(3),
  downloadAttachments: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
  headless: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default("true"),
});

export type CrawlerConfig = z.infer<typeof configSchema>;

export function loadConfig(): CrawlerConfig {
  return configSchema.parse({
    flexEmail: process.env.FLEX_EMAIL,
    flexPassword: process.env.FLEX_PASSWORD,
    flexBaseUrl: process.env.FLEX_BASE_URL || undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    requestDelayMs: process.env.REQUEST_DELAY_MS || undefined,
    maxRetries: process.env.MAX_RETRIES || undefined,
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS || undefined,
    headless: process.env.HEADLESS || undefined,
  });
}
