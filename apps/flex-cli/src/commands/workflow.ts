import path from "node:path";
import { loadConfig, type Config } from "../config/index.js";
import { createLogger, type Logger } from "../logger/index.js";
import {
  authenticate,
  cleanup,
  listCorporations,
  switchCustomer,
  type AuthContext,
  type Corporation,
} from "../auth/index.js";
import { listAvailableTemplates, findTemplate, decodeEmoji } from "../workflow/templates.js";
import { resolvePolicy } from "../workflow/policy.js";
import { uploadAttachment } from "../workflow/file.js";
import {
  createDraft,
  getDocument,
  registerAttachments,
  submitDocument,
  type DocumentPayload,
} from "../workflow/document.js";
import { checkDraftForSubmit, type DraftCheck } from "../workflow/draft-check.js";
import { HttpError } from "../auth/index.js";
import {
  readInputFile,
  renderInputTemplate,
  serializeFieldValue,
  type WorkflowInput,
} from "../workflow/io.js";
import type { ResolvedPolicy, UploadedAttachment } from "../workflow/types.js";
import { resolveTargetCorporation } from "./live-common.js";
import { getWorkflowReadUsage, runWorkflowReadCommand } from "./workflow-read.js";

/**
 * `flex-ax workflow {templates|describe|submit}` 디스패처.
 * cli.ts 에서 case 하나로 받아 여기로 위임한다.
 */
export async function runWorkflow(argv: string[] = process.argv.slice(3)): Promise<void> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "templates":
      await cmdTemplates(rest);
      return;
    case "describe":
      await cmdDescribe(rest);
      return;
    case "submit":
      await cmdSubmit(rest);
      return;
    case "list":
    case "show":
    case "attachments":
    case "status":
      await runWorkflowReadCommand(sub, rest, "WORKFLOW");
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      process.exit(sub === undefined ? 1 : 0);
    default:
      console.error(`[FLEX-AX:WORKFLOW:ERROR] 알 수 없는 서브커맨드: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: flex-ax workflow <subcommand>

Subcommands:
  templates                       작성 가능한 양식 목록 출력
  describe <key|이름> [> file]    양식 명세를 입력 YAML 형태로 출력
  submit <file>                   채운 YAML로 결재 문서 작성/제출
  submit <file> --document-key <key>
                                  이미 임시저장된 문서를 그 YAML 내용 그대로 상신 (새 문서를 만들지 않음)
  list                            결재 문서 목록 조회
  show <documentKey>              결재 문서 상세 조회
  status <documentKey>            결재 상태/결재선 요약 조회
  attachments <documentKey>       첨부파일 목록 조회

Options (모든 서브커맨드 공통):
  --customer <customerIdHash>     다중 법인일 때 대상 법인 지정
  --draft                         (submit 전용) 임시저장까지만 (제출 호출 생략)
  --dry-run                       (submit 전용) 호출하지 않고 페이로드만 stdout
                                  (--document-key 와 함께면 draft 확인(조회)까지만 하고 상신은 생략)
  --document-key <key>            (submit 전용) 기존 draft에 상신. 상신 전 문서를 다시 읽어
                                  없으면 종료코드 4, 이미 상신됐으면 5, 양식이 다르거나 제목·입력값이
                                  YAML과 다르면(UI에서 수정됨) 6 으로 거부한다

${getWorkflowReadUsage("workflow")}

Examples:
  flex-ax workflow templates
  flex-ax workflow describe "비용 결제 요청" > request.yaml
  flex-ax workflow submit ./request.yaml --draft
  flex-ax workflow submit ./request.yaml --document-key 8d2f...
  flex-ax workflow list --box in-progress
  flex-ax workflow status 8d2f...
`);
}

// --- 옵션 파서 (각 서브커맨드 공통) ---

export interface CommonOpts {
  customer?: string;
  draft: boolean;
  dryRun: boolean;
  documentKey?: string;
  positional: string[];
}

export function parseOpts(args: string[]): CommonOpts {
  const opts: CommonOpts = { draft: false, dryRun: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--customer") {
      opts.customer = args[++i];
    } else if (a === "--document-key") {
      const v = args[++i];
      if (!v || v.startsWith("--")) {
        throw new Error("--document-key 에 documentKey를 지정하세요.");
      }
      opts.documentKey = v;
    } else if (a === "--draft") {
      opts.draft = true;
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else {
      opts.positional.push(a);
    }
  }
  return opts;
}

// --- 공통: 인증 + 법인 전환 ---

async function setupAuth(
  opts: CommonOpts,
  logger: Logger,
): Promise<{ authCtx: AuthContext; config: Config; corp: Corporation }> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const authCtx = await authenticate(config, logger);

  let corporations: Corporation[];
  try {
    corporations = await listCorporations(authCtx, config.flexBaseUrl);
  } catch (error) {
    await cleanup(authCtx);
    throw error;
  }

  if (corporations.length === 0) {
    await cleanup(authCtx);
    logger.error("작성 가능한 법인이 없습니다");
    process.exit(1);
  }

  const target = resolveTargetCorporation(corporations, opts, config, logger);

  await switchCustomer(authCtx, config.flexBaseUrl, target.customerIdHash, target.userIdHash);
  logger.info("법인 컨텍스트 설정", { name: target.name, customerIdHash: target.customerIdHash });

  return { authCtx, config, corp: target };
}

// --- 서브커맨드 구현 ---

async function cmdTemplates(args: string[]): Promise<void> {
  const logger = createLogger("WORKFLOW");
  const opts = parseOpts(args);

  const { authCtx, config } = await setupAuth(opts, logger);
  try {
    const templates = await listAvailableTemplates(authCtx, config.flexBaseUrl);
    if (templates.length === 0) {
      console.log("(작성 가능한 양식이 없습니다)");
      return;
    }
    // 안정적으로 grep 가능하도록 한 줄에 한 양식 — emoji는 일부 터미널에서 폭이 어긋나므로
    // 마지막 컬럼으로 보낸다.
    for (const t of templates) {
      const tags = t.tags?.map((tg) => tg.name).join(",") ?? "";
      const emoji = decodeEmoji(t.emoji);
      console.log(
        `${t.templateKey}\t${t.name}${tags ? "\t[" + tags + "]" : ""}${emoji ? "\t" + emoji : ""}`,
      );
    }
  } finally {
    await cleanup(authCtx);
  }
}

async function cmdDescribe(args: string[]): Promise<void> {
  const logger = createLogger("WORKFLOW");
  const opts = parseOpts(args);
  const query = opts.positional[0];
  if (!query) {
    logger.error("describe 대상 양식을 지정하세요 (templateKey 또는 이름)");
    process.exit(1);
  }

  const { authCtx, config } = await setupAuth(opts, logger);
  try {
    const templates = await listAvailableTemplates(authCtx, config.flexBaseUrl);
    const template = findTemplate(templates, query);
    logger.info("양식 매칭", { name: template.name, templateKey: template.templateKey });
    const policy = await resolvePolicy(authCtx, config.flexBaseUrl, template);
    process.stdout.write(renderInputTemplate(policy));
  } finally {
    await cleanup(authCtx);
  }
}

async function cmdSubmit(args: string[]): Promise<void> {
  const logger = createLogger("WORKFLOW");
  const opts = parseOpts(args);
  const filePath = opts.positional[0];
  if (!filePath) {
    logger.error("submit 입력 파일을 지정하세요 (예: flex-ax workflow submit ./request.yaml)");
    process.exit(1);
  }

  if (opts.documentKey && opts.draft) {
    logger.error("--document-key 와 --draft 는 함께 쓸 수 없습니다 (이미 임시저장된 문서를 상신하는 옵션)");
    process.exit(1);
  }

  // 파일 먼저 읽고 검증 — 인증 실패보다 입력 검증 실패가 먼저 보이는 게 디버깅 친화적.
  const input = await readInputFile(filePath);
  if (opts.documentKey && input.attachments.length > 0) {
    logger.error("--document-key 로 상신할 때는 attachments 를 지원하지 않습니다 (draft에 이미 등록된 첨부를 쓰세요)");
    process.exit(1);
  }

  const { authCtx, config } = await setupAuth(opts, logger);
  try {
    const templates = await listAvailableTemplates(authCtx, config.flexBaseUrl);
    const template = findTemplate(templates, input.templateKey);
    const policy = await resolvePolicy(authCtx, config.flexBaseUrl, template);
    logger.info("양식 매칭", { name: template.name, templateKey: template.templateKey });

    const payload = buildPayload(input, policy);
    validateRequiredFields(input, policy);

    if (opts.documentKey) {
      await submitExistingDraft(authCtx, config.flexBaseUrl, opts.documentKey, payload, opts.dryRun, logger);
      return;
    }

    if (opts.dryRun) {
      // dry-run은 attachments 업로드도 건너뛴다 — 호출 0건. 페이로드 모양만 stdout으로 덤프.
      const stub: DocumentPayload = { ...payload, attachments: [] };
      console.log(JSON.stringify(serializeForDryRun(stub, input.attachments), null, 2));
      return;
    }

    // 첨부파일 업로드 (있을 때만)
    const uploaded: UploadedAttachment[] = [];
    for (let i = 0; i < input.attachments.length; i++) {
      const file = path.resolve(path.dirname(path.resolve(filePath)), input.attachments[i]);
      logger.info(`첨부 ${i + 1}/${input.attachments.length} 업로드`, { file });
      const att = await uploadAttachment(authCtx, config.flexBaseUrl, file);
      uploaded.push(att);
    }
    payload.attachments = uploaded;

    // draft 생성 → 첨부 등록 (영구 fileKey 변환)
    const { documentKey } = await createDraft(authCtx, config.flexBaseUrl, payload);
    logger.info("draft 생성", { documentKey });
    if (uploaded.length > 0) {
      payload.attachments = await registerAttachments(
        authCtx,
        config.flexBaseUrl,
        documentKey,
        payload,
      );
      logger.info("영구 fileKey 변환 완료", { count: payload.attachments.length });
    }

    if (opts.draft) {
      console.log(`[FLEX-AX:WORKFLOW] 임시저장 완료: documentKey=${documentKey}`);
      console.log(
        `[FLEX-AX:WORKFLOW] UI에서 마저 작성: ${config.flexBaseUrl}/workflow/archive/my?documentKey=${documentKey}`,
      );
      return;
    }

    const result = await submitDocument(authCtx, config.flexBaseUrl, documentKey, payload);
    console.log(
      `[FLEX-AX:WORKFLOW] 제출 완료: code=${result.code} status=${result.status} documentKey=${result.documentKey}`,
    );
  } finally {
    await cleanup(authCtx);
  }
}

// --- 기존 draft 상신 (--document-key) ---

/** 거부 사유 → 종료 코드. 호출자(봇 등)가 출력 문구 대신 코드로 분기할 수 있게 고정한다. */
export const DRAFT_REFUSAL_EXIT: Record<"missing" | "submitted" | "template" | "modified", number> = {
  missing: 4,
  submitted: 5,
  template: 6,
  modified: 6,
};

/**
 * 없는(삭제된) 문서 응답인지. flex 는 없는 documentKey 에 404 가 아니라
 * 400 + `code: "WORKFLOW_400_023"`("문서를 찾을 수 없습니다.")를 준다 (2026-11-04 실측).
 * 404/410 도 같이 받는다. 그 밖의 4xx/5xx 는 일시 오류일 수 있어 그대로 던진다.
 */
export const MISSING_DOCUMENT_CODE = "WORKFLOW_400_023";

export function isMissingDocumentError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return false;
  if (error.status === 404 || error.status === 410) return true;
  if (error.status !== 400) return false;
  try {
    const body = JSON.parse(error.body) as { code?: unknown };
    return body?.code === MISSING_DOCUMENT_CODE;
  } catch {
    return false;
  }
}

async function submitExistingDraft(
  authCtx: AuthContext,
  baseUrl: string,
  documentKey: string,
  payload: DocumentPayload,
  dryRun: boolean,
  logger: Logger,
): Promise<void> {
  let check: DraftCheck | { ok: false; reason: "missing"; detail: string };
  try {
    const detail = await getDocument(authCtx, baseUrl, documentKey);
    check = checkDraftForSubmit(detail, payload);
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
    check = { ok: false, reason: "missing", detail: `HTTP ${(error as HttpError).status}` };
  }

  if (!check.ok) {
    logger.error("기존 draft 상신 거부", { reason: check.reason, documentKey, detail: check.detail });
    console.log(`[FLEX-AX:WORKFLOW] 상신 거부: reason=${check.reason} documentKey=${documentKey}`);
    await cleanup(authCtx);
    process.exit(DRAFT_REFUSAL_EXIT[check.reason]);
  }

  if (dryRun) {
    console.log(`[FLEX-AX:WORKFLOW] dry-run: draft 확인 통과, 상신은 생략 documentKey=${documentKey}`);
    console.log(JSON.stringify(serializeForDryRun(payload, []), null, 2));
    return;
  }

  const result = await submitDocument(authCtx, baseUrl, documentKey, payload);
  console.log(
    `[FLEX-AX:WORKFLOW] 제출 완료: code=${result.code} status=${result.status} documentKey=${result.documentKey}`,
  );
}

// --- payload 빌더 ---

function buildPayload(input: WorkflowInput, policy: ResolvedPolicy): DocumentPayload {
  // YAML 의 한글 이름 → policy의 inputFieldIdHash 매핑 사전 구축
  const byName = new Map(policy.fields.map((f) => [f.name, f]));

  const inputs: Array<{ inputFieldIdHash: string; value: string }> = [];

  // 정책에 정의된 모든 필드를 순서대로 발행 — 사용자가 빈 값으로 둔 필드도 빈 문자열로 보낸다.
  // 그래야 prefill 처리/required 검증이 서버에서 일관되게 동작한다.
  for (const field of policy.fields) {
    const raw = input.fields[field.name];
    let value = serializeFieldValue(field, raw);

    // 사용자가 값을 비웠지만 prefill 가능한 경우 (이름/조직) 자동 채움
    if (
      (raw === undefined || raw === "" || raw === null) &&
      field.prefill?.defaultValue &&
      field.type === "STRING"
    ) {
      value = field.prefill.defaultValue;
    }
    inputs.push({ inputFieldIdHash: field.inputFieldIdHash, value });
  }

  // YAML 에는 있지만 policy에 없는 필드는 사용자 오타 가능성이 높음 → 경고성 에러
  const policyNames = new Set(policy.fields.map((f) => f.name));
  for (const key of Object.keys(input.fields)) {
    if (!policyNames.has(key)) {
      throw new Error(
        `양식에 존재하지 않는 필드입니다: "${key}". 사용 가능한 필드: ${[...policyNames].join(", ")}`,
      );
    }
  }

  return {
    templateKey: policy.templateKey,
    title: input.title,
    content: input.content && input.content.length > 0 ? input.content : policy.defaultContent,
    inputs,
    attachments: [], // submit 시 채워짐
    approvalLines: input.approvalProcess.lines.map((l) => ({
      step: l.step,
      actors: l.actors.map((a) => ({ type: a.type, value: a.value })),
    })),
    referrers: input.approvalProcess.referrers.map((r) => ({
      type: r.type,
      value: r.value,
      notificationSetting: r.notificationSetting,
    })),
    matchingData: input.approvalProcess.matchingData,
    options: input.approvalProcess.options ?? policy.options,
  };
}

function validateRequiredFields(input: WorkflowInput, policy: ResolvedPolicy): void {
  const missing: string[] = [];
  for (const field of policy.fields) {
    if (!field.required) continue;
    if (field.prefill?.defaultValue) continue; // prefill로 자동 채워질 거라 검사 면제
    const v = input.fields[field.name];
    if (v === undefined || v === null || v === "") missing.push(field.name);
    else if (Array.isArray(v) && v.length === 0) missing.push(field.name);
  }
  if (missing.length > 0) {
    throw new Error(`필수 필드가 비어 있습니다: ${missing.join(", ")}`);
  }
}

function serializeForDryRun(
  payload: DocumentPayload,
  attachments: string[],
): unknown {
  return {
    documentKey: "<assigned-on-create>",
    document: {
      templateKey: payload.templateKey,
      title: payload.title,
      content: payload.content,
      inputs: payload.inputs,
      attachments: attachments.map((p) => ({
        path: p,
        note: "dry-run 이라 업로드는 건너뜀",
      })),
    },
    approvalProcess: {
      lines: payload.approvalLines,
      referrers: payload.referrers,
      matchingData: payload.matchingData,
      options: payload.options,
    },
  };
}
