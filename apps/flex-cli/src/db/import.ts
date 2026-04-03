import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ImportResult {
  templates: number;
  instances: number;
  attendance: number;
  users: number;
  fieldValues: number;
  approvalLines: number;
  comments: number;
  attachments: number;
}

export async function importToSqlite(
  outputDir: string,
  dbPath: string,
  logger: Logger,
): Promise<ImportResult> {
  const result: ImportResult = {
    templates: 0, instances: 0, attendance: 0, users: 0,
    fieldValues: 0, approvalLines: 0, comments: 0, attachments: 0,
  };

  // DB 초기화
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF"); // 임포트 순서 무관하게 처리, 완료 후 체크

  // schema.sql은 이 파일과 같은 디렉토리에 있음
  // tsx: src/db/import.ts → src/db/schema.sql
  // tsc: dist/db/import.js → src/db/schema.sql (dist에는 복사 안 되므로 src 폴백)
  let schemaPath = path.join(__dirname, "schema.sql");
  try {
    await readFile(schemaPath, "utf-8");
  } catch {
    schemaPath = path.resolve(__dirname, "../../src/db/schema.sql");
  }
  const schema = await readFile(schemaPath, "utf-8");
  db.exec(schema);

  // 사용자 수집용
  const users = new Map<string, { name: string; aliases: Set<string> }>();

  function upsertUser(id: string | undefined, name: string): void {
    if (!id || !name || name === "unknown") return;
    const existing = users.get(id);
    if (existing) {
      if (existing.name !== name) {
        existing.aliases.add(name);
      }
    } else {
      users.set(id, { name, aliases: new Set() });
    }
  }

  // Prepared statements
  const stmts = {
    template: db.prepare(`
      INSERT OR REPLACE INTO templates (id, name, category, created_at, updated_at, raw)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    templateField: db.prepare(`
      INSERT OR REPLACE INTO template_fields (template_id, name, type, required, options, currency, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    ensureTemplate: db.prepare(`
      INSERT OR IGNORE INTO templates (id, name) VALUES (?, ?)
    `),
    instance: db.prepare(`
      INSERT OR REPLACE INTO instances (id, document_number, template_id, drafter_id, drafted_at, status, content_html, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    fieldValue: db.prepare(`
      INSERT OR REPLACE INTO field_values (instance_id, field_name, field_type, value_text, value_number, value_date, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    approvalLine: db.prepare(`
      INSERT OR REPLACE INTO approval_lines (instance_id, step_order, seq, type, approver_id, approver_name, status, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    file: db.prepare(`
      INSERT OR REPLACE INTO files (file_key, file_name, local_path, source, file_size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    attachment: db.prepare(`
      INSERT OR REPLACE INTO attachments (instance_id, file_key)
      VALUES (?, ?)
    `),
    referrer: db.prepare(`
      INSERT OR REPLACE INTO referrers (instance_id, user_id, user_name, type)
      VALUES (?, ?, ?, ?)
    `),
    comment: db.prepare(`
      INSERT OR REPLACE INTO comments (id, instance_id, author_id, author_name, type, content, is_system, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    attendance: db.prepare(`
      INSERT OR REPLACE INTO attendance (id, user_id, type, policy_id, date_from, date_to, days, minutes, status, applied_at, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    user: db.prepare(`
      INSERT OR REPLACE INTO users (id, name, aliases)
      VALUES (?, ?, ?)
    `),
    meta: db.prepare(`
      INSERT OR REPLACE INTO crawl_meta (key, value)
      VALUES (?, ?)
    `),
  };

  // === Templates ===
  const templatesDir = path.join(outputDir, "templates");
  const templateFiles = await safeReaddir(templatesDir);

  const importTemplates = db.transaction(() => {
    for (const file of templateFiles) {
      if (!file.endsWith(".json")) continue;
      const data = readJsonSync(path.join(templatesDir, file));

      stmts.template.run(
        data.id, data.name, data.category ?? null,
        data.createdAt ?? null, data.updatedAt ?? null,
        JSON.stringify(data._raw ?? null),
      );
      result.templates++;

      for (let i = 0; i < (data.fields ?? []).length; i++) {
        const f = data.fields[i];
        const currency = f.description?.match(/currency:\s*(\w+)/)?.[1] ?? null;
        stmts.templateField.run(
          data.id, f.name, f.type,
          f.required ? 1 : 0,
          f.options ? JSON.stringify(f.options) : null,
          currency, i,
        );
      }
    }
  });
  importTemplates();
  logger.info(`템플릿 ${result.templates}건 임포트`);

  // === Instances ===
  const instancesDir = path.join(outputDir, "instances");
  const instanceFiles = await safeReaddir(instancesDir);

  // 배치 트랜잭션 (1000건씩)
  const BATCH = 1000;
  for (let i = 0; i < instanceFiles.length; i += BATCH) {
    const batch = instanceFiles.slice(i, i + BATCH);
    const importBatch = db.transaction(() => {
      for (const file of batch) {
        if (!file.endsWith(".json")) continue;
        const data = readJsonSync(path.join(instancesDir, file));
        importInstance(data, stmts, result, users, upsertUser);
      }
    });
    importBatch();
    logger.progress("인스턴스 임포트", Math.min(i + BATCH, instanceFiles.length), instanceFiles.length);
  }
  logger.info(`\n인스턴스 ${result.instances}건 임포트`);

  // === Attendance ===
  const attendanceDir = path.join(outputDir, "attendance");
  const attendanceFiles = await safeReaddir(attendanceDir);

  const importAttendance = db.transaction(() => {
    for (const file of attendanceFiles) {
      if (!file.endsWith(".json")) continue;
      const data = readJsonSync(path.join(attendanceDir, file));

      upsertUser(data.applicant?.id, data.applicant?.name);

      stmts.attendance.run(
        data.id, data.applicant?.id ?? null, data.type,
        data.details?.policyId ?? data._raw?.timeOffPolicyId ?? null,
        data.details?.dateFrom ?? data.appliedAt ?? null,
        data.details?.dateTo ?? null,
        data.details?.days ?? null,
        data.details?.minutes ?? null,
        data.status,
        data.appliedAt ?? null,
        JSON.stringify(data._raw ?? null),
      );
      result.attendance++;
    }
  });
  importAttendance();
  if (result.attendance > 0) {
    logger.info(`근태/휴가 ${result.attendance}건 임포트`);
  }

  // === Users ===
  const importUsers = db.transaction(() => {
    for (const [id, info] of users) {
      stmts.user.run(id, info.name, JSON.stringify([...info.aliases]));
      result.users++;
    }
  });
  importUsers();
  logger.info(`사용자 ${result.users}명 임포트`);

  // === Meta ===
  stmts.meta.run("imported_at", new Date().toISOString());
  stmts.meta.run("source_dir", outputDir);

  // crawl-report.json 읽기
  try {
    const report = readJsonSync(path.join(outputDir, "crawl-report.json"));
    stmts.meta.run("crawled_at", report.startedAt ?? "");
    stmts.meta.run("crawl_duration_ms", String(report.durationMs ?? 0));
  } catch {
    // 없으면 무시
  }

  // FK 무결성 체크
  const fkErrors = db.pragma("foreign_key_check") as unknown[];
  if (fkErrors.length > 0) {
    logger.warn(`FK 무결성 위반 ${fkErrors.length}건 (참조 누락)`);
  }

  db.close();
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function importInstance(
  data: any,
  stmts: Record<string, Database.Statement>,
  result: ImportResult,
  users: Map<string, { name: string; aliases: Set<string> }>,
  upsertUser: (id: string | undefined, name: string) => void,
): void {
  const raw = data._raw;
  const doc = raw?.document;
  const drafter = data.drafter;

  upsertUser(drafter?.id, drafter?.name ?? "");

  // 템플릿이 없으면 placeholder 생성
  stmts.ensureTemplate.run(data.templateId, data.templateName ?? data.templateId);

  stmts.instance.run(
    data.id,
    data.documentNumber ?? "",
    data.templateId,
    drafter?.id ?? null,
    data.draftedAt,
    data.status,
    (doc?.content as string) ?? null,
    JSON.stringify(raw ?? null),
  );
  result.instances++;

  // Fields
  const fields = data.fields ?? [];
  const inputs = doc?.inputs ?? [];
  const fieldCurrency = new Map<string, string>();
  for (const input of inputs) {
    if (input.inputField?.data) {
      try {
        const parsed = JSON.parse(input.inputField.data);
        if (parsed.currencyCode) {
          fieldCurrency.set(input.inputField.name, parsed.currencyCode);
        }
      } catch { /* ignore */ }
    }
  }

  for (const f of fields) {
    const valueStr = typeof f.value === "string" ? f.value : JSON.stringify(f.value);
    let valueNumber: number | null = null;
    let valueDate: string | null = null;
    const currency = fieldCurrency.get(f.fieldName) ?? null;

    if (f.fieldType === "AMOUNT_OF_MONEY" || f.fieldType === "NUMBER") {
      const n = parseFloat(valueStr);
      if (!isNaN(n)) valueNumber = n;
    }
    if (f.fieldType === "DATE" && /^\d{4}-\d{2}-\d{2}/.test(valueStr)) {
      valueDate = valueStr.slice(0, 10);
    }

    stmts.fieldValue.run(
      data.id, f.fieldName, f.fieldType,
      valueStr, valueNumber, valueDate, currency,
    );
    result.fieldValues++;
  }

  // Approval lines
  const approvalLine = data.approvalLine ?? [];
  const seqCounter = new Map<number, number>();
  for (const al of approvalLine) {
    const seq = seqCounter.get(al.order) ?? 0;
    seqCounter.set(al.order, seq + 1);

    const rawLines = raw?.approvalProcess?.lines ?? [];
    let approverId: string | null = null;
    const rawLine = rawLines.find((l: any) => l.step === al.order);
    if (rawLine?.actors[seq]) {
      approverId = rawLine.actors[seq].actedUserIdHash
        ?? rawLine.actors[seq].resolvedTarget.userIdHashes?.[0]
        ?? null;
    }

    upsertUser(approverId ?? undefined, al.approver.name);

    stmts.approvalLine.run(
      data.id, al.order, seq, al.type,
      approverId, al.approver.name,
      al.status, al.processedAt ?? null,
    );
    result.approvalLines++;
  }

  // Attachments → files + attachments
  const attachments = data.attachments ?? [];
  const rawAttachments = doc?.attachments ?? [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const rawAtt = rawAttachments[i];
    const fileKey = rawAtt?.file?.fileKey ?? `${data.id}/${att.fileName}`;
    stmts.file.run(
      fileKey, att.fileName, att.localPath ?? null,
      "attachment", att.fileSize ?? null, att.mimeType ?? null,
    );
    stmts.attachment.run(data.id, fileKey);
    result.attachments++;
  }

  // Referrers (from raw)
  const rawReferrers = raw?.approvalProcess?.referrers ?? [];
  for (const ref of rawReferrers) {
    const target = ref.resolvedTarget;
    const refUserId = target?.userIdHashes?.[0] ?? null;
    const refName = target?.displayName ?? "";
    upsertUser(refUserId ?? undefined, refName);
    if (refUserId) {
      stmts.referrer.run(data.id, refUserId, refName, target?.type ?? null);
    }
  }

  // Comments (from raw)
  const rawComments = doc?.comments ?? [];
  for (const c of rawComments) {
    upsertUser(c.writer.idHash, c.writer.name);
    stmts.comment.run(
      c.idHash, data.id as string,
      c.writer.idHash, c.writer.name,
      c.type, c.content ?? null,
      c.writtenBySystem ? 1 : 0,
      c.createdAt,
      c.updatedAt ?? null,
    );
    result.comments++;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJsonSync(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
