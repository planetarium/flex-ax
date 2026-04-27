import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { createFlexHrStorage } from "./storage.js";

const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

const STATUS_MAP: Record<string, string> = {
  DONE: "APPROVED",
  APPROVED: "APPROVED",
  COMPLETED: "APPROVED",
  IN_PROGRESS: "PENDING",
  PENDING: "PENDING",
  WAITING: "PENDING",
  DECLINED: "REJECTED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
  CANCELED: "CANCELLED",
  DRAFT: "DRAFT",
};

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  json: "application/json",
  hwp: "application/x-hwp",
  hwpx: "application/x-hwpx",
};

interface ImportCustomerOptions {
  sourceDir: string;
  customerIdHash: string;
  config: Config;
  logger: Logger;
}

interface CrawlReport {
  templates?: { totalCount?: number };
  instances?: { totalCount?: number };
}

interface FileRow {
  file_key: string;
  file_name: string | null;
  local_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  instance_id: string | null;
}

interface UploadOutcome {
  file: FileRow;
  key: string;
  size: number;
  mime: string;
  uploaderId: string;
}

export async function importCustomerToFlexHr({
  sourceDir,
  customerIdHash,
  config,
  logger,
}: ImportCustomerOptions): Promise<void> {
  validateDirectDumpConfig(config);

  const dbPath = path.join(sourceDir, "flex-ax.db");
  const sqlite = new Database(dbPath, { readonly: true });
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  const storage = createFlexHrStorage(config);
  if (config.flexHrImportDryRun) {
    await validateStorageDryRun(storage, customerIdHash, logger);
  }

  let report: CrawlReport | null = null;
  try {
    report = JSON.parse(await readFile(path.join(sourceDir, "crawl-report.json"), "utf-8")) as CrawlReport;
  } catch {
    report = null;
  }

  const counters = {
    workspacesInserted: 0,
    workspacesExisting: 0,
    membersInserted: 0,
    membersExisting: 0,
    employeesInserted: 0,
    employeesExisting: 0,
    botInserted: 0,
    botExisting: 0,
    formsInserted: 0,
    formsExisting: 0,
    approvalsInserted: 0,
    approvalsExisting: 0,
    filesConsidered: 0,
    filesSkipped: 0,
    filesFailed: 0,
    filesR2Uploaded: 0,
    filesR2Existing: 0,
    filesDbInserted: 0,
    filesDbExisting: 0,
  };

  const bump = (
    result: pg.QueryResult,
    insertedCounter: keyof typeof counters,
    existingCounter: keyof typeof counters,
  ): void => {
    if (result.rowCount && result.rowCount > 0) {
      counters[insertedCounter]++;
    } else {
      counters[existingCounter]++;
    }
  };

  let metadataCommitted = false;
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO accounts (wallet_address, display_name) VALUES ($1, NULL)
       ON CONFLICT (wallet_address) DO NOTHING`,
      [config.flexHrOwnerWallet],
    );

    const sqliteCustomer = sqlite.prepare("SELECT * FROM customers LIMIT 1").get() as
      | {
          name?: string;
          business_reg_number?: string;
          phone_number?: string;
          address_full?: string;
        }
      | undefined;

    const workspaceName =
      config.flexHrWorkspaceName || sqliteCustomer?.name || `Flex Workspace ${customerIdHash}`;
    const workspaceSlug = `flex-${customerIdHash.toLowerCase()}`;

    const slugOwner = await client.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE slug = $1 AND id <> $2",
      [workspaceSlug, customerIdHash],
    );
    if (slugOwner.rowCount && slugOwner.rowCount > 0) {
      throw new Error(
        `slug "${workspaceSlug}" is already used by workspace ${slugOwner.rows[0].id}`,
      );
    }

    const workspaceExisted = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [
      customerIdHash,
    ]);
    await client.query(
      `INSERT INTO workspaces (id, owner_wallet, name, slug, business_number, address, phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
      [
        customerIdHash,
        config.flexHrOwnerWallet,
        workspaceName,
        workspaceSlug,
        sqliteCustomer?.business_reg_number ?? null,
        sqliteCustomer?.address_full ?? null,
        sqliteCustomer?.phone_number ?? null,
      ],
    );
    if (workspaceExisted.rowCount && workspaceExisted.rowCount > 0) {
      counters.workspacesExisting++;
    } else {
      counters.workspacesInserted++;
    }

    for (const memberWallet of config.flexHrMemberWallets) {
      if (memberWallet === config.flexHrOwnerWallet) continue;
      await client.query(
        `INSERT INTO accounts (wallet_address, display_name) VALUES ($1, NULL)
         ON CONFLICT (wallet_address) DO NOTHING`,
        [memberWallet],
      );
      const result = await client.query(
        `INSERT INTO workspace_members (workspace_id, wallet_address, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [customerIdHash, memberWallet],
      );
      bump(result, "membersInserted", "membersExisting");
    }

    const employeeId = (rawUserId: string) => `${customerIdHash}:${rawUserId}`;
    const upsertEmployee = async (
      id: string,
      employeeNumber: string,
      name: string,
      status: "ACTIVE" | "SYSTEM",
    ): Promise<pg.QueryResult> => {
      const result = await client.query(
        `INSERT INTO employees (id, workspace_id, employee_number, name, status)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [id, customerIdHash, employeeNumber, name, status],
      );
      if (!result.rowCount) {
        const ok = await client.query(
          "SELECT 1 FROM employees WHERE id = $1 AND workspace_id = $2",
          [id, customerIdHash],
        );
        if (!ok.rowCount) {
          throw new Error(`employee upsert conflict: ${id}`);
        }
      }
      return result;
    };

    const users = sqlite.prepare("SELECT id, name FROM users").all() as { id: string; name: string }[];
    for (const user of users) {
      const result = await upsertEmployee(
        employeeId(user.id),
        `FLEX-${user.id}`,
        user.name || user.id,
        "ACTIVE",
      );
      bump(result, "employeesInserted", "employeesExisting");
    }

    const botId = `SYSTEM-FLEX-IMPORT-${customerIdHash}`;
    const botResult = await upsertEmployee(
      botId,
      "__flex_import__",
      "Flex Import Bot",
      "SYSTEM",
    );
    bump(botResult, "botInserted", "botExisting");

    const templates = sqlite.prepare("SELECT id, name, category, raw FROM templates").all() as {
      id: string;
      name: string;
      category: string | null;
      raw: string | null;
    }[];
    for (const template of templates) {
      let fields: unknown = [];
      if (template.raw) {
        try {
          fields = JSON.parse(template.raw)?.detail?.inputFields ?? [];
        } catch {
          fields = [];
        }
      }
      const result = await client.query(
        `INSERT INTO approval_forms (id, workspace_id, name, category, fields)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          template.id,
          customerIdHash,
          template.name,
          template.category ?? "Uncategorized",
          JSON.stringify(fields),
        ],
      );
      if (!result.rowCount) {
        const ok = await client.query(
          "SELECT 1 FROM approval_forms WHERE id = $1 AND workspace_id = $2",
          [template.id, customerIdHash],
        );
        if (!ok.rowCount) {
          throw new Error(`approval form upsert conflict: ${template.id}`);
        }
      }
      bump(result, "formsInserted", "formsExisting");
    }

    const instances = sqlite
      .prepare(
        "SELECT id, document_number, template_id, drafter_id, drafted_at, status, content_html, raw FROM instances",
      )
      .all() as {
      id: string;
      document_number: string;
      template_id: string;
      drafter_id: string | null;
      drafted_at: string;
      status: string;
      content_html: string | null;
      raw: string | null;
    }[];

    const knownUserIds = new Set(users.map((user) => user.id));
    for (const instance of instances) {
      if (instance.drafter_id && !knownUserIds.has(instance.drafter_id)) {
        const result = await upsertEmployee(
          employeeId(instance.drafter_id),
          `FLEX-${instance.drafter_id}`,
          instance.drafter_id,
          "ACTIVE",
        );
        knownUserIds.add(instance.drafter_id);
        bump(result, "employeesInserted", "employeesExisting");
      }
    }

    for (const instance of instances) {
      const requesterId = instance.drafter_id ? employeeId(instance.drafter_id) : botId;
      const result = await client.query(
        `INSERT INTO approvals
          (id, workspace_id, requester_id, form_id, type, title, content, status, form_data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::approval_status, $9::jsonb, $10, $10)
         ON CONFLICT DO NOTHING`,
        [
          instance.id,
          customerIdHash,
          requesterId,
          instance.template_id,
          "FLEX_WORKFLOW",
          titleFromRaw(instance.raw, instance.document_number || instance.id),
          instance.content_html,
          mapApprovalStatus(instance.status),
          safeJson(instance.raw),
          instance.drafted_at,
        ],
      );
      bump(result, "approvalsInserted", "approvalsExisting");
    }

    if (config.flexHrImportDryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
      metadataCommitted = true;
    }

    if (config.flexHrImportDryRun) {
      logger.info("flex-hr direct dump dry-run 완료", {
        customerIdHash,
        workspaceName,
        storageBackend: storage.backend,
      });
      return;
    }

    const fileRows = sqlite
      .prepare(
        `SELECT f.file_key, f.file_name, f.local_path, f.file_size, f.mime_type,
                a.instance_id
         FROM files f
         LEFT JOIN attachments a ON a.file_key = f.file_key`,
      )
      .all() as FileRow[];

    const instanceIds = new Set(instances.map((instance) => instance.id));
    const deriveInstanceId = (row: FileRow): string | null => {
      if (row.instance_id) return row.instance_id;
      if (!row.local_path) return null;
      const match = row.local_path.match(/(?:^|\/)attachments\/([^/]+)\//);
      if (match && instanceIds.has(match[1])) return match[1];
      return null;
    };

    const byKey = new Map<string, FileRow>();
    for (const row of fileRows) {
      const previous = byKey.get(row.file_key);
      if (!previous || (!previous.instance_id && row.instance_id)) {
        byKey.set(row.file_key, row);
      }
    }
    for (const [key, row] of byKey) {
      if (!row.instance_id) {
        byKey.set(key, { ...row, instance_id: deriveInstanceId(row) });
      }
    }

    const files = Array.from(byKey.values());
    counters.filesConsidered = files.length;

    const instanceDrafter = new Map<string, string | null>();
    for (const instance of instances) {
      instanceDrafter.set(instance.id, instance.drafter_id);
    }

    const sourceRoot = path.resolve(sourceDir);
    const uploadOutcomes = await mapConcurrent(
      files,
      config.flexHrImportParallel,
      async (file): Promise<UploadOutcome | null> => {
        try {
          if (!file.local_path) {
            counters.filesSkipped++;
            return null;
          }

          const match = file.local_path.match(/(?:^|\/)(attachments|templates|instances)\/(.+)$/);
          if (!match) {
            throw new Error(`local_path outside known subdirs: ${file.local_path}`);
          }

          const absolutePath = path.resolve(sourceRoot, `${match[1]}/${match[2]}`);
          if (absolutePath !== sourceRoot && !absolutePath.startsWith(sourceRoot + path.sep)) {
            throw new Error(`path escapes source directory: ${file.local_path}`);
          }

          const storageKey = `${customerIdHash}/files/${file.file_key}`;
          let fileSize = file.file_size ?? 0;
          const mime = guessMime(file.file_name, file.mime_type);

          const head = await storage.head(storageKey);
          if (head.exists) {
            fileSize = head.size ?? fileSize;
            counters.filesR2Existing++;
          } else {
            const fileStat = await stat(absolutePath);
            fileSize = fileStat.size;
            await storage.put(storageKey, createReadStream(absolutePath), {
              contentType: mime,
              contentLength: fileSize,
            });
            counters.filesR2Uploaded++;
          }

          const drafterId = file.instance_id ? instanceDrafter.get(file.instance_id) : null;
          return {
            file,
            key: storageKey,
            size: fileSize,
            mime,
            uploaderId: drafterId ? employeeId(drafterId) : botId,
          };
        } catch (error) {
          counters.filesFailed++;
          logger.error("파일 업로드 실패", {
            customerIdHash,
            fileKey: file.file_key,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
    );

    for (const outcome of uploadOutcomes) {
      if (!outcome) continue;
      const result = await client.query(
        `INSERT INTO file_uploads
          (workspace_id, uploaded_by_id, approval_id, file_name, original_name, mime_type, size, path, access_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'WORKSPACE')
         ON CONFLICT (workspace_id, path) DO NOTHING`,
        [
          customerIdHash,
          outcome.uploaderId,
          outcome.file.instance_id ?? null,
          outcome.file.file_name ?? outcome.file.file_key,
          outcome.file.file_name ?? outcome.file.file_key,
          outcome.mime,
          outcome.size,
          outcome.key,
        ],
      );
      if (result.rowCount && result.rowCount > 0) {
        counters.filesDbInserted++;
      } else {
        counters.filesDbExisting++;
      }
    }

    logger.info("flex-hr direct dump 완료", {
      customerIdHash,
      workspaceName,
      templates: report?.templates?.totalCount ?? templates.length,
      instances: report?.instances?.totalCount ?? instances.length,
      filesUploaded: counters.filesR2Uploaded,
      filesExisting: counters.filesR2Existing,
      filesFailed: counters.filesFailed,
    });
  } catch (error) {
    if (!metadataCommitted) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    sqlite.close();
    await client.end();
  }
}

function validateDirectDumpConfig(config: Config): void {
  if (!config.flexHrOwnerWallet) {
    throw new Error("FLEX_HR_OWNER_WALLET is required when FLEX_HR_DIRECT_DUMP=true");
  }
  if (!WALLET_RE.test(config.flexHrOwnerWallet)) {
    throw new Error("FLEX_HR_OWNER_WALLET must be a 0x-prefixed 40 hex wallet address");
  }
  for (const memberWallet of config.flexHrMemberWallets) {
    if (!WALLET_RE.test(memberWallet)) {
      throw new Error(`FLEX_HR_MEMBER_WALLETS contains an invalid wallet address: ${memberWallet}`);
    }
  }
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL or DB_SETUP_URL is required when FLEX_HR_DIRECT_DUMP=true");
  }
}

async function validateStorageDryRun(
  storage: ReturnType<typeof createFlexHrStorage>,
  customerIdHash: string,
  logger: Logger,
): Promise<void> {
  const probeKey = `${customerIdHash}/__dry_run_probe__/${Date.now()}`;
  await storage.head(probeKey);
  logger.info("flex-hr storage dry-run 검증 완료", {
    customerIdHash,
    storageBackend: storage.backend,
    probe: probeKey,
  });
}

function mapApprovalStatus(status: string | null): string {
  if (!status) return "PENDING";
  return STATUS_MAP[status.toUpperCase()] ?? "PENDING";
}

function guessMime(fileName: string | null, existing: string | null): string {
  if (existing) return existing;
  if (!fileName) return "application/octet-stream";
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function titleFromRaw(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { document?: { title?: unknown } };
    if (typeof parsed.document?.title === "string" && parsed.document.title.trim()) {
      return parsed.document.title.trim();
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function safeJson(raw: string | null): string {
  if (!raw) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}
