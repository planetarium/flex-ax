/**
 * 워크플로우 결재 문서 작성에 필요한 내부 타입 정의.
 *
 * 서버 응답을 그대로 옮겨두면 inner 객체 분기가 코드 곳곳에 퍼지므로,
 * 우리가 다루는 좁은 모양으로 한 번 정규화한 뒤 모듈 간 공유한다.
 */

/** GET /api/v3/approval-document-template/available-templates 응답 한 항목 */
export interface AvailableTemplate {
  templateKey: string;
  name: string;
  emoji?: string;
  description?: string;
  tags?: Array<{ idHash: string; name: string; displayOrder?: number }>;
}

/** resolve-policy 응답에서 추출한 입력 필드 메타데이터 */
export interface InputFieldMeta {
  /** 서버 페이로드의 `inputFieldIdHash`로 그대로 들어가는 키 */
  inputFieldIdHash: string;
  /** YAML/UI에 노출되는 사람-친화 이름. 한 양식 안에서 유일하다고 가정한다. */
  name: string;
  displayOrder: number;
  /**
   * 서버가 정의한 필드 타입.
   * STRING / SELECT / MULTISELECT / DATE / AMOUNT_OF_MONEY / TASK_REFERENCE / ...
   * 실제 캡처에서 본 값들을 narrow type으로 좁혀두지 않은 이유는
   * 새 양식이 추가될 때마다 코드 변경 없이 통과시키기 위해서다.
   */
  type: string;
  required: boolean;
  /** SELECT/MULTISELECT의 선택지 등 양식별 보조 데이터 (서버가 JSON 문자열로 줌) */
  data?: string;
  /** name·dept 등 작성자 컨텍스트로 자동 채워지는 prefill 정보 */
  prefill?: {
    defaultValue: string;
    type: string; // NAME / DEPARTMENT / NONE / DEFAULT
  };
}

/** 결재선 한 단계의 actor */
export interface ApprovalActor {
  /** USER, RELATIVE_DEPT_HEAD 등 — 서버 enum을 그대로 통과시킨다 */
  type: string;
  value: string;
  /** describe 출력에서 주석으로 노출하기 위한 사람 이름 */
  displayName?: string;
}

export interface ApprovalLine {
  step: number;
  actors: ApprovalActor[];
}

export interface Referrer {
  type: string;
  value: string;
  displayName?: string;
  /** START / END / START_AND_END / NONE — 서버 enum 그대로 */
  notificationSetting: string;
}

/**
 * resolve-policy가 결재선 매칭에 쓴 컨텍스트. submit 페이로드에 그대로 동봉해야
 * 서버가 "이 결재선은 이 매칭에서 나온 것"이라고 인식한다.
 */
export interface MatchingData {
  matchedAt: string;
  matchHistoryId: string;
}

/** 양식 한 개에 대한 작성 가능한 모양으로 정규화된 정책 */
export interface ResolvedPolicy {
  templateKey: string;
  templateName: string;
  emoji?: string;
  /** UI에서 보이는 본문 placeholder (HTML). 사용자가 미지정 시 default로 쓴다 */
  defaultContent: string;
  fields: InputFieldMeta[];
  approvalLines: ApprovalLine[];
  referrers: Referrer[];
  matchingData: MatchingData;
  /** approvalProcess.option 그대로 통과 — 1차 구현에서는 caller가 건드리지 않는다 */
  options: Record<string, unknown>;
}

/** pre-signed-url 발급 응답 */
export interface PreSignedUrlResponse {
  fileKey: string;
  name: string;
  mimeType: string;
  size: number;
  uploadMethod: string; // "PRE_SIGNED"
  uploadUrl: string;
  sourceType: string;
}

/** 업로드 완료 후 영구 fileKey를 들고 있는 attachment 표현 */
export interface UploadedAttachment {
  /** 업로드 직후 받은 임시 fileKey — draft 1회 갱신 후에는 영구 fileKey로 교체된다 */
  fileKey: string;
  name: string;
  size: number;
  mimeType: string;
  /** draft 응답에서 받아 저장 — submit 페이로드에 들어가는 영구 키 */
  permFileKey?: string;
}
