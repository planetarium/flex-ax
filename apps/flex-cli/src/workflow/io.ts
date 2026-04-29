import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import { parseFieldOptions } from "./policy.js";
import type {
  ApprovalLine,
  InputFieldMeta,
  Referrer,
  ResolvedPolicy,
} from "./types.js";

/**
 * 사용자가 작성하는 입력 YAML.
 *
 * fields는 양식 한글 이름 → 값으로 매핑한다 (idHash 노출 회피).
 * approvalProcess 의 actors는 userIdHash 직입력이지만 describe가 각 항목에 displayName
 * 코멘트를 자동 첨부하므로 사람이 보기에 충분히 명확하다.
 */
// RELATIVE_DEPT_HEAD 의 value 같은 항목은 "1" 처럼 숫자로만 보이면 YAML이 number로
// 파싱하기 때문에, value 필드는 string|number 모두 받고 string으로 정규화한다.
const valueAsString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .pipe(z.string().min(1));

export const inputSchema = z.object({
  templateKey: z.string().min(1),
  title: z.string().min(1),
  content: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(z.string()).default([]),
  approvalProcess: z.object({
    lines: z
      .array(
        z.object({
          step: z.number().int(),
          actors: z
            .array(
              z.object({
                type: z.string().default("USER"),
                value: valueAsString,
              }),
            )
            .min(1),
        }),
      )
      .min(1),
    referrers: z
      .array(
        z.object({
          type: z.string().default("USER"),
          value: valueAsString,
          notificationSetting: z.string().default("START_AND_END"),
        }),
      )
      .default([]),
    matchingData: z.object({
      matchedAt: z.string().min(1),
      matchHistoryId: z.string().min(1),
    }),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type WorkflowInput = z.infer<typeof inputSchema>;

export async function readInputFile(filePath: string): Promise<WorkflowInput> {
  const text = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw new Error(
      `YAML 파싱 실패 (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = inputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`입력 파일 스키마 검증 실패 (${filePath}):\n${issues}`);
  }
  return result.data;
}

/**
 * YAML 필드 값(임의 타입)을 서버 페이로드에 들어가는 문자열로 직렬화한다.
 *
 * 서버는 필드 값을 모두 string으로 받으며, MULTISELECT/SELECT는 JSON 배열 문자열을,
 * AMOUNT_OF_MONEY는 숫자를 문자열화한 값을, DATE는 ISO 날짜를 기대한다.
 * 사용자가 YAML에서 자연스럽게 적은 값(`["PL KR"]`, `10000`, `2026-04-29` 등)을
 * 서버가 원하는 모양으로 한 번에 변환한다.
 */
export function serializeFieldValue(field: InputFieldMeta, raw: unknown): string {
  // 빈 값 처리 — required 필드의 빈 값은 caller가 사전에 차단한다고 가정.
  if (raw === undefined || raw === null || raw === "") {
    if (field.type === "MULTISELECT" || field.type === "TASK_REFERENCE") return "[]";
    return "";
  }

  switch (field.type) {
    case "MULTISELECT": {
      const arr = Array.isArray(raw) ? raw : [raw];
      return JSON.stringify(arr.map((x) => String(x)));
    }
    case "SELECT": {
      // SELECT도 서버는 JSON 배열로 받는다 (관찰: `[\"기타\"]`)
      const arr = Array.isArray(raw) ? raw : [raw];
      return JSON.stringify(arr.map((x) => String(x)));
    }
    case "TASK_REFERENCE": {
      const arr = Array.isArray(raw) ? raw : [raw];
      return JSON.stringify(arr);
    }
    case "AMOUNT_OF_MONEY":
      return String(raw);
    case "DATE":
      // 사용자가 YAML에 `2026-04-29` 로 적으면 yaml 파서가 Date 객체로 만들어줄 수 있어
      // ISO 문자열로 정규화한다.
      if (raw instanceof Date) return raw.toISOString().slice(0, 10);
      return String(raw);
    default:
      return String(raw);
  }
}

/**
 * resolve-policy 응답을 사용자가 채울 빈 YAML 문서로 렌더링한다.
 *
 * yaml 패키지의 Document API로 코멘트를 다는 대신 직접 문자열로 만든다 — 결재선 actor
 * 옆에 ` # 노윤경 (Operation)` 같은 주석을 한 줄에 정확히 붙이는 것이 Document API보다
 * 템플릿 리터럴이 훨씬 단순하다. 본문 외 부분은 yaml.stringify에 위임.
 */
export function renderInputTemplate(policy: ResolvedPolicy): string {
  const fieldsBlock = renderFieldsBlock(policy.fields);
  const linesBlock = renderApprovalLinesBlock(policy.approvalLines);
  const referrersBlock = renderReferrersBlock(policy.referrers);

  // matchingData / options는 그대로 통과 → yaml.stringify 위임
  const matchingDataYaml = indent(
    YAML.stringify({ matchingData: policy.matchingData }, { lineWidth: 0 }).trimEnd(),
    "  ",
  );
  const optionsYaml = indent(
    YAML.stringify({ options: policy.options }, { lineWidth: 0 }).trimEnd(),
    "  ",
  );

  return `# ${policy.emoji ? policy.emoji + " " : ""}${policy.templateName}
# templateKey: ${policy.templateKey}
#
# 'fields' 와 'attachments' 를 채워 \`flex-ax workflow submit <file>\` 으로 제출하세요.
# approvalProcess 는 양식 기본값입니다 — 결재자를 변경하려면 actors의 userIdHash를 수정하세요.

templateKey: ${policy.templateKey}
title: ""
# content: ""              # 비워두면 양식 기본 본문이 사용됩니다

fields:
${fieldsBlock}

attachments: []
# attachments:
#   - ./receipts/april.pdf

approvalProcess:
  lines:
${linesBlock}
  referrers:
${referrersBlock}
${matchingDataYaml}
${optionsYaml}
`;
}

function renderFieldsBlock(fields: InputFieldMeta[]): string {
  if (fields.length === 0) return "  {}";
  const lines: string[] = [];
  for (const f of fields) {
    const requiredTag = f.required ? "필수" : "선택";
    const typeTag = f.type;
    const optionsHint = describeOptions(f);
    const prefillHint = f.prefill?.defaultValue
      ? ` / prefill="${f.prefill.defaultValue}"`
      : "";
    lines.push(
      `  # [${requiredTag}] ${typeTag}${optionsHint}${prefillHint}`,
    );
    const placeholder = defaultPlaceholderFor(f);
    lines.push(`  ${quoteKeyIfNeeded(f.name)}: ${placeholder}`);
  }
  return lines.join("\n");
}

function describeOptions(field: InputFieldMeta): string {
  const opts = parseFieldOptions(field);
  if (!opts || opts.length === 0) return "";
  return ` / options: ${opts.join(", ")}`;
}

function defaultPlaceholderFor(field: InputFieldMeta): string {
  // prefill 이 있는 필드(이름/조직 등)는 그 값을 그대로 채워준다 — UI도 동일하게 동작.
  if (field.prefill?.defaultValue) {
    return JSON.stringify(field.prefill.defaultValue);
  }
  switch (field.type) {
    case "MULTISELECT":
    case "TASK_REFERENCE":
      return "[]";
    case "AMOUNT_OF_MONEY":
      return "0";
    case "DATE":
      return '""';
    default:
      return '""';
  }
}

function renderApprovalLinesBlock(lines: ApprovalLine[]): string {
  if (lines.length === 0) return "    []";
  const out: string[] = [];
  for (const line of lines) {
    out.push(`    - step: ${line.step}`);
    out.push(`      actors:`);
    for (const actor of line.actors) {
      const comment = actor.displayName ? `  # ${actor.displayName}` : "";
      // type이 USER가 아닐 경우만 명시 — 90%의 경우 USER라 노이즈 줄임
      if (actor.type === "USER") {
        out.push(`        - { value: ${quoteValue(actor.value)} }${comment}`);
      } else {
        out.push(
          `        - { type: ${actor.type}, value: ${quoteValue(actor.value)} }${comment}`,
        );
      }
    }
  }
  return out.join("\n");
}

function renderReferrersBlock(refs: Referrer[]): string {
  if (refs.length === 0) return "    []";
  const out: string[] = [];
  for (const r of refs) {
    const comment = r.displayName ? `  # ${r.displayName}` : "";
    out.push(
      `    - { type: ${r.type}, value: ${quoteValue(r.value)}, notificationSetting: ${r.notificationSetting} }${comment}`,
    );
  }
  return out.join("\n");
}

function quoteValue(v: string): string {
  // 영숫자/_/-만 있으면 따옴표 없이, 아니면 JSON 인코딩
  if (/^[A-Za-z0-9_-]+$/.test(v)) return v;
  return JSON.stringify(v);
}

function quoteKeyIfNeeded(key: string): string {
  // YAML 키에 콜론이나 시작 특수문자가 있으면 인용 — 한글/공백/괄호는 무인용으로 통과 가능.
  if (/[:#&*!|>'"%@`,\[\]\{\}]/.test(key)) return JSON.stringify(key);
  return key;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}
