/**
 * 이미 만들어 둔 임시저장(draft) 문서를 `submit --document-key` 로 상신하기 전의 안전 검사.
 *
 * 다른 도구(예: 운영 봇)가 draft를 만들어 두고 나중에 사람이 버튼으로 상신하는 흐름에서,
 * 그 사이 문서가 상신·삭제·수정됐을 수 있다. 이 모듈은 서버에서 다시 읽은 문서 상세와
 * 지금 보낼 페이로드를 비교해 "그대로 상신해도 되는지"만 판정한다 (순수 함수, 호출 0건).
 *
 *   - submitted: 이미 상신된 문서 (문서번호가 있거나 상태가 진행/종결)
 *   - template:  다른 양식의 문서
 *   - modified:  제목·입력값이 페이로드와 다름 — 사람이 flex UI에서 고쳤을 수 있으니
 *                덮어쓰지 않는다. 고친 내용으로 올리려면 UI에서 직접 상신한다.
 *
 * 본문(content HTML)과 결재선은 비교하지 않는다 — 서버가 HTML을 정규화해 돌려줄 수 있고,
 * 상세 응답의 결재선은 resolvedTarget 모양이라 입력(resolveTarget)과 1:1로 맞출 수 없다.
 */

/** 상세 응답(GET /api/v3/approval-document/approval-documents/{documentKey})에서 쓰는 부분만. */
export interface DraftDetail {
  document?: {
    documentKey?: string;
    code?: string | null;
    templateKey?: string;
    status?: string;
    title?: string;
    inputs?: Array<{
      value?: string | null;
      inputField?: { idHash?: string; name?: string };
    }>;
  };
}

export interface DraftSubmitPayload {
  templateKey: string;
  title: string;
  inputs: Array<{ inputFieldIdHash: string; value: string }>;
}

export type DraftCheck =
  | { ok: true }
  | { ok: false; reason: "submitted" | "template" | "modified"; detail: string };

/** 상신 뒤에만 나오는 상태. draft 자체의 상태 이름은 확인된 값이 없어 "이 목록이 아니면 draft"로 본다. */
export const SUBMITTED_STATUSES = new Set(["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"]);

export function checkDraftForSubmit(detail: DraftDetail, payload: DraftSubmitPayload): DraftCheck {
  const doc = detail.document ?? {};
  const status = doc.status ?? "";
  if ((typeof doc.code === "string" && doc.code.trim() !== "") || SUBMITTED_STATUSES.has(status)) {
    return {
      ok: false,
      reason: "submitted",
      detail: `status=${status || "?"} code=${doc.code || "-"}`,
    };
  }
  if (doc.templateKey && doc.templateKey !== payload.templateKey) {
    return {
      ok: false,
      reason: "template",
      detail: `document=${doc.templateKey} input=${payload.templateKey}`,
    };
  }

  const changed: string[] = [];
  if ((doc.title ?? "").trim() !== payload.title.trim()) changed.push("제목");

  const byId = new Map<string, { name: string; value: string }>();
  for (const input of doc.inputs ?? []) {
    const id = input.inputField?.idHash;
    if (!id) continue;
    byId.set(id, { name: input.inputField?.name ?? id, value: input.value ?? "" });
  }
  const seen = new Set<string>();
  for (const want of payload.inputs) {
    seen.add(want.inputFieldIdHash);
    const have = byId.get(want.inputFieldIdHash);
    if (!sameFieldValue(have?.value ?? "", want.value)) {
      changed.push(have?.name ?? want.inputFieldIdHash);
    }
  }
  // 페이로드에 없는 칸에 값이 들어 있으면(양식 개정 등) 덮어쓰지 않는다
  for (const [id, have] of byId) {
    if (!seen.has(id) && !isEmptyValue(have.value)) changed.push(have.name);
  }

  if (changed.length > 0) {
    return { ok: false, reason: "modified", detail: `달라진 항목: ${changed.join(", ")}` };
  }
  return { ok: true };
}

function isEmptyValue(v: string): boolean {
  const t = v.trim();
  return t === "" || t === "[]";
}

/**
 * 서버가 돌려준 값과 보낼 값이 같은지. 직렬화 차이(JSON 배열 공백, "2000000" vs "2000000.0")는
 * 같은 값으로 본다 — 엄격하게 비교하면 매번 "수정됨"으로 거부돼 기능이 죽고, 느슨하게 비교하면
 * 사람이 고친 값을 덮어쓴다. 여기선 의미가 같은 표현만 같다고 본다.
 */
export function sameFieldValue(have: string, want: string): boolean {
  const a = have.trim();
  const b = want.trim();
  if (a === b) return true;
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  const ja = parseJsonArray(a);
  const jb = parseJsonArray(b);
  if (ja && jb) {
    return ja.length === jb.length && ja.every((x, i) => x === jb[i]);
  }
  const na = Number(a.replace(/,/g, ""));
  const nb = Number(b.replace(/,/g, ""));
  if (a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return false;
}

function parseJsonArray(s: string): string[] | null {
  if (!s.startsWith("[")) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!Array.isArray(v)) return null;
    return v.map((x) => String(x));
  } catch {
    return null;
  }
}
