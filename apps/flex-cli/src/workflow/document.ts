import type { AuthContext } from "../auth/index.js";
import { postJson } from "./http.js";
import type { ApprovalLine, Referrer, ResolvedPolicy, UploadedAttachment } from "./types.js";

/**
 * draft/submit 페이로드의 "공통 본문" 한 덩어리.
 *
 * 둘은 endpoint와 attachments의 uploaded 플래그만 다르고 나머지는 동일하므로
 * caller가 두 번 만들지 않도록 한 번에 빌드한다.
 */
export interface DocumentPayload {
  templateKey: string;
  title: string;
  /** HTML 문자열. 빈 문자열이면 양식 default가 들어감 */
  content: string;
  inputs: Array<{ inputFieldIdHash: string; value: string }>;
  attachments: UploadedAttachment[];
  approvalLines: ApprovalLine[];
  referrers: Referrer[];
  matchingData: ResolvedPolicy["matchingData"];
  options: Record<string, unknown>;
}

interface DraftCreateResponse {
  draft?: {
    document?: {
      documentKey?: string;
      attachments?: DraftAttachmentResp[];
    };
  };
}

interface DraftAttachmentResp {
  idHash?: string;
  file?: { fileKey?: string; fileName?: string; downloadUrl?: string };
}

interface SubmitResponse {
  document?: {
    documentKey?: string;
    code?: string;
    status?: string;
  };
  approvalProcess?: { status?: string };
}

/**
 * 빈 attachments 로 draft를 생성한다. 첫 호출이라 documentKey가 응답으로 내려옴.
 */
export async function createDraft(
  authCtx: AuthContext,
  baseUrl: string,
  payload: DocumentPayload,
): Promise<{ documentKey: string }> {
  const body = serializePayload(payload, { uploadedFlag: true });
  const res = await postJson<DraftCreateResponse>(
    authCtx,
    `${baseUrl}/api/v3/approval-document/approval-documents/draft`,
    body,
  );
  const documentKey = res.draft?.document?.documentKey;
  if (!documentKey) {
    throw new Error("draft 생성 응답에 documentKey가 없습니다");
  }
  return { documentKey };
}

/**
 * 임시 fileKey로 attachments를 등록하고 응답에서 영구 fileKey를 추출한다.
 *
 * 서버는 이 호출에서 S3 임시 객체를 영구 저장소로 이동시키고 새 fileKey를 발급한다.
 * 두 fileKey는 1:1 대응되며 attachments 배열 순서가 보존된다고 가정한다.
 */
export async function registerAttachments(
  authCtx: AuthContext,
  baseUrl: string,
  documentKey: string,
  payload: DocumentPayload,
): Promise<UploadedAttachment[]> {
  if (payload.attachments.length === 0) return [];

  const body = serializePayload(payload, { uploadedFlag: false });
  const res = await postJson<DraftCreateResponse>(
    authCtx,
    `${baseUrl}/api/v3/approval-document/approval-documents/draft?documentKey=${encodeURIComponent(documentKey)}`,
    body,
  );

  const respAttachments = res.draft?.document?.attachments ?? [];
  if (respAttachments.length !== payload.attachments.length) {
    throw new Error(
      `draft 응답의 attachments 개수가 요청과 다릅니다: req=${payload.attachments.length}, resp=${respAttachments.length}`,
    );
  }

  // 매칭 우선순위:
  //   1) idx 매칭의 fileName이 일치 → 인덱스 그대로
  //   2) 동일 인덱스의 fileName이 다르면 같은 이름의 응답 항목으로 fallback
  //      (서버가 정렬을 바꾸는 케이스 대비)
  //   3) 응답에 fileName 자체가 없으면 인덱스 매칭에 의존 (캡처 시점엔 항상 있었음)
  // 동일 이름 다중 첨부 케이스는 first-match로 떨어진다 — CLI에서 같은 파일을 두 번
  // 명시하는 건 사용자 책임 영역이라 1차 구현은 여기까지만 방어한다.
  return payload.attachments.map((att, idx) => {
    const perm = pickPermFileKey(respAttachments, idx, att.name);
    if (!perm) {
      throw new Error(
        `attachment ${idx} (${att.name})에 영구 fileKey가 발급되지 않았습니다`,
      );
    }
    return { ...att, permFileKey: perm };
  });
}

function pickPermFileKey(
  resp: DraftAttachmentResp[],
  idx: number,
  expectedName: string,
): string | undefined {
  const direct = resp[idx];
  if (direct?.file?.fileKey && (!direct.file.fileName || direct.file.fileName === expectedName)) {
    return direct.file.fileKey;
  }
  const byName = resp.find((r) => r.file?.fileName === expectedName && r.file?.fileKey);
  if (byName?.file?.fileKey) return byName.file.fileKey;
  return direct?.file?.fileKey;
}

/**
 * 결재 상신. 응답에서 발급된 문서번호(code)를 돌려준다.
 */
export async function submitDocument(
  authCtx: AuthContext,
  baseUrl: string,
  documentKey: string,
  payload: DocumentPayload,
): Promise<{ documentKey: string; code: string; status: string }> {
  const body = serializePayload(payload, { uploadedFlag: true });
  const res = await postJson<SubmitResponse>(
    authCtx,
    `${baseUrl}/api/v3/approval-document/approval-documents?documentKey=${encodeURIComponent(documentKey)}`,
    body,
  );
  const code = res.document?.code;
  if (!code) {
    throw new Error("submit 응답에 문서번호(code)가 없습니다");
  }
  return {
    documentKey: res.document?.documentKey ?? documentKey,
    code,
    status: res.document?.status ?? "UNKNOWN",
  };
}

/**
 * draft/submit 페이로드 직렬화.
 *
 * uploadedFlag=false 는 "이 fileKey는 임시 fileKey라 영구로 변환해줘" 신호이고,
 * uploadedFlag=true 는 "이미 영구 fileKey로 굳었다" 신호다.
 * 후자에 임시 fileKey를 실으면 서버가 거부한다.
 */
function serializePayload(
  payload: DocumentPayload,
  opts: { uploadedFlag: boolean },
): unknown {
  const attachments = payload.attachments.map((att) => ({
    name: att.name,
    fileKey: opts.uploadedFlag ? (att.permFileKey ?? att.fileKey) : att.fileKey,
    uploaded: opts.uploadedFlag,
  }));

  return {
    document: {
      templateKey: payload.templateKey,
      title: payload.title,
      content: payload.content,
      inputs: payload.inputs,
      attachments,
    },
    approvalProcess: {
      lines: payload.approvalLines.map((l) => ({
        step: l.step,
        actors: l.actors.map((a) => ({
          resolveTarget: { type: a.type, value: a.value },
        })),
      })),
      referrers: payload.referrers.map((r) => ({
        resolveTarget: { type: r.type, value: r.value },
        notificationSetting: r.notificationSetting,
      })),
      option: payload.options,
      matchingData: payload.matchingData,
    },
  };
}
