import { z } from "zod";

const configSchema = z
  .object({
    authMode: z.enum(["credentials", "sso", "playwriter"]).default("credentials"),
    /** @deprecated playwriterSession is no longer used — CDP relay replaces CLI sessions */
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
    flexHrDirectDump: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default("false"),
    flexHrOwnerWallet: z.string().default(""),
    flexHrWorkspaceName: z.string().default(""),
    flexHrMemberWallets: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    flexHrImportParallel: z.coerce.number().int().min(1).default(8),
    flexHrImportDryRun: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default("false"),
    flexHrKeepScratch: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .default("false"),
    flexHrScratchRoot: z.string().default(""),
    databaseUrl: z.string().default(""),
    storageBackend: z.enum(["local", "r2"]).default("local"),
    localUploadDir: z.string().default(".uploads"),
    r2Endpoint: z.string().default(""),
    r2AccessKeyId: z.string().default(""),
    r2SecretAccessKey: z.string().default(""),
    r2Bucket: z.string().default(""),
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
    crawlSensitive: process.env.FLEX_CRAWL_SENSITIVE || undefined,
    skipEndpoints: process.env.FLEX_SKIP_ENDPOINTS || undefined,
    customers: process.env.FLEX_CUSTOMERS || undefined,
    flexHrDirectDump: process.env.FLEX_HR_DIRECT_DUMP || undefined,
    flexHrOwnerWallet: process.env.FLEX_HR_OWNER_WALLET || undefined,
    flexHrWorkspaceName: process.env.FLEX_HR_WORKSPACE_NAME || undefined,
    flexHrMemberWallets: process.env.FLEX_HR_MEMBER_WALLETS || undefined,
    flexHrImportParallel: process.env.FLEX_HR_IMPORT_PARALLEL || undefined,
    flexHrImportDryRun: process.env.FLEX_HR_IMPORT_DRY_RUN || undefined,
    flexHrKeepScratch: process.env.FLEX_HR_KEEP_SCRATCH || undefined,
    flexHrScratchRoot: process.env.FLEX_HR_SCRATCH_ROOT || undefined,
    databaseUrl: process.env.DB_SETUP_URL || process.env.DATABASE_URL || undefined,
    storageBackend: process.env.STORAGE_BACKEND || undefined,
    localUploadDir: process.env.LOCAL_UPLOAD_DIR || undefined,
    r2Endpoint: process.env.R2_ENDPOINT || undefined,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || undefined,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || undefined,
    r2Bucket: process.env.R2_BUCKET || undefined,
  });
}
