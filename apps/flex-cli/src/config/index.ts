import { z } from "zod";

const configSchema = z
  .object({
    authMode: z.enum(["credentials", "sso", "playwriter"]).default("credentials"),
    playwriterSession: z.string().default(""),
    flexEmail: z.string().default(""),
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
    headless: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default("true"),
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    authMode: process.env.AUTH_MODE || undefined,
    playwriterSession: process.env.PLAYWRITER_SESSION || undefined,
    flexEmail: process.env.FLEX_EMAIL || undefined,
    flexPassword: process.env.FLEX_PASSWORD || undefined,
    flexBaseUrl: process.env.FLEX_BASE_URL || undefined,
    outputDir: process.env.OUTPUT_DIR || undefined,
    catalogPath: process.env.CATALOG_PATH || undefined,
    requestDelayMs: process.env.REQUEST_DELAY_MS || undefined,
    maxRetries: process.env.MAX_RETRIES || undefined,
    downloadAttachments: process.env.DOWNLOAD_ATTACHMENTS || undefined,
    headless: process.env.HEADLESS || undefined,
  });
}
