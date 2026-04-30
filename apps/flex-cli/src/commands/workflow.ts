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
  registerAttachments,
  submitDocument,
  type DocumentPayload,
} from "../workflow/document.js";
import {
  readInputFile,
  renderInputTemplate,
  serializeFieldValue,
  type WorkflowInput,
} from "../workflow/io.js";
import type { ResolvedPolicy, UploadedAttachment } from "../workflow/types.js";
import { resolveTargetCorporation } from "./live-common.js";

/**
 * `flex-ax workflow {templates|describe|submit}` 디스패처.
 * cli.ts 에서 case 하나로 받아 여기로 위임한다.
 */
export async function runWorkflow(): Promise<void> {
  // process.argv = [node, cli.js, "workflow", <sub>, ...rest]
  const [sub, ...rest] = process.argv.slice(3);

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
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      process.exit(sub === undefined ? 1 : 0);
      return;
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

Options (모든 서브커맨드 공통):
  --customer <customerIdHash>     다중 법인일 때 대상 법인 지정
  --draft                         (submit 전용) 임시저장까지만 (제출 호출 생략)
  --dry-run                       (submit 전용) 호출하지 않고 페이로드만 stdout

Examples:
  flex-ax workflow templates
  flex-ax workflow describe "비용 결제 요청" > request.yaml
  flex-ax workflow submit ./request.yaml --draft
`);
}

// --- 옵션 파서 (각 서브커맨드 공통) ---

interface CommonOpts {
  customer?: string;
  draft: boolean;
  dryRun: boolean;
  positional: string[];
}

function parseOpts(args: string[]): CommonOpts {
  const opts: CommonOpts = { draft: false, dryRun: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--customer") {
      opts.customer = args[++i];
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

  // 파일 먼저 읽고 검증 — 인증 실패보다 입력 검증 실패가 먼저 보이는 게 디버깅 친화적.
  const input = await readInputFile(filePath);

  const { authCtx, config } = await setupAuth(opts, logger);
  try {
    const templates = await listAvailableTemplates(authCtx, config.flexBaseUrl);
    const template = findTemplate(templates, input.templateKey);
    const policy = await resolvePolicy(authCtx, config.flexBaseUrl, template);
    logger.info("양식 매칭", { name: template.name, templateKey: template.templateKey });

    const payload = buildPayload(input, policy);
    validateRequiredFields(input, policy);

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
