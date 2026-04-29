import type { AuthContext } from "../auth/index.js";
import { postJson } from "./http.js";
import type {
  ApprovalLine,
  AvailableTemplate,
  InputFieldMeta,
  MatchingData,
  Referrer,
  ResolvedPolicy,
} from "./types.js";

/**
 * resolve-policy 응답을 우리가 필요한 모양으로 정규화한다.
 *
 * 서버 응답은 wrapper가 깊고(approvalProcess.lines[].actors[].resolvedTarget…)
 * draft/submit 페이로드가 요구하는 모양(resolveTarget — d 빠짐)과 1글자 다르다.
 * 그 사소한 차이를 caller마다 다시 풀어쓰면 사고나기 좋아서 한 번에 정규화한다.
 */
export async function resolvePolicy(
  authCtx: AuthContext,
  baseUrl: string,
  template: AvailableTemplate,
): Promise<ResolvedPolicy> {
  const url = `${baseUrl}/action/v3/approval-document-template/templates/${template.templateKey}/resolve-policy`;
  const raw = await postJson<RawResolvePolicyResponse>(authCtx, url, {});

  const fields = (raw.template?.inputFields ?? []).map<InputFieldMeta>((f) => ({
    inputFieldIdHash: f.idHash,
    name: f.name,
    displayOrder: f.displayOrder,
    type: f.type,
    required: !!f.required,
    data: f.data,
    prefill: f.prefill,
  }));
  fields.sort((a, b) => a.displayOrder - b.displayOrder);

  // resolve-policy 응답은 결재선/referrers 를 approvalPolicyMatched.matchedStep 안에 둔다.
  // 반면 draft/submit 페이로드에서는 approvalProcess.lines / approvalProcess.referrers /
  // approvalProcess.matchingData 로 평탄화돼 들어간다. 그 비대칭을 한 번에 정규화한다.
  const matched = raw.approvalPolicyMatched;
  if (!matched) {
    throw new Error(
      `resolve-policy 응답에 approvalPolicyMatched 가 없습니다 (templateKey=${template.templateKey})`,
    );
  }

  const stepActors = matched.matchedStep?.stepActors ?? [];
  const approvalLines: ApprovalLine[] = stepActors.map((l) => ({
    step: l.step,
    actors: (l.actors ?? []).map((a) => ({
      type: a.resolveTarget?.type ?? "USER",
      value: a.resolveTarget?.value ?? "",
      // resolve-policy 응답은 displayName을 주지 않는다. describe 출력에서 이름 주석을
      // 넣으려면 별도 user lookup이 필요한데, YAGNI 에 따라 1차 구현은 hash만 노출.
    })),
  }));

  const referrers: Referrer[] = (matched.matchedStep?.referrers ?? []).map((r) => ({
    type: r.resolveTarget?.type ?? "USER",
    value: r.resolveTarget?.value ?? "",
    notificationSetting: r.notificationSetting ?? "START_AND_END",
  }));

  // 응답 키는 matchMetadata, 요청 키는 matchingData — 내부에서는 요청 모양(matchingData)으로 통일.
  const matchingData: MatchingData = matched.matchMetadata ?? {
    matchedAt: "",
    matchHistoryId: "",
  };
  if (!matchingData.matchHistoryId) {
    throw new Error(
      `resolve-policy 응답에 matchMetadata 가 없습니다 (templateKey=${template.templateKey})`,
    );
  }

  return {
    templateKey: template.templateKey,
    templateName: template.name,
    emoji: template.emoji,
    defaultContent: raw.template?.content ?? "",
    fields,
    approvalLines,
    referrers,
    matchingData,
    options: matched.option ?? { approvalStepEditEnabled: true },
  };
}

// --- raw API 응답 타입 ---

interface RawResolvePolicyResponse {
  template?: {
    templateKey?: string;
    content?: string;
    inputFields?: Array<{
      idHash: string;
      name: string;
      displayOrder: number;
      type: string;
      data?: string;
      required?: boolean;
      prefill?: { defaultValue: string; type: string };
    }>;
  };
  approvalPolicyMatched?: {
    matchMetadata?: MatchingData;
    option?: Record<string, unknown>;
    matchedStep?: {
      stepActors?: Array<{
        step: number;
        actors?: Array<{ resolveTarget?: { type: string; value: string } }>;
      }>;
      referrers?: Array<{
        resolveTarget?: { type: string; value: string };
        notificationSetting?: string;
      }>;
    };
  };
}

/** SELECT/MULTISELECT 같은 enum 필드의 선택지를 파싱한다 (서버는 JSON 문자열로 줌) */
export function parseFieldOptions(field: InputFieldMeta): string[] | null {
  if (!field.data) return null;
  try {
    const parsed = JSON.parse(field.data);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    return null;
  } catch {
    return null;
  }
}
