import type {
  ApprovalStatus,
  ApprovalStep,
  AttachmentInfo,
  FieldValue,
  UserInfo,
} from "./common.js";

/** 워크플로우 인스턴스(결재 문서) */
export interface WorkflowInstance {
  id: string;
  documentNumber: string;
  templateId: string;
  templateName: string;
  drafter: UserInfo;
  draftedAt: string;
  lastUpdatedAt: string | null;
  /**
   * 다운스트림 (reflex 등)에서 raw upsert / CDC fanout의 noop write를
   * 거르기 위한 변경 감지 해시. `document.updatedAt`이 댓글 mutation을
   * 반영하지 않는 한계를 보완한다 — 댓글 idHash 집합 + 최대 updatedAt /
   * createdAt + status / approvalProcess.status 등을 함께 hash해서, 같은
   * doc 두 번 fetch 시 변경이 있을 때만 hash가 달라진다.
   *
   * 새로 매핑하는 인스턴스는 항상 string이지만, 이 필드가 추가되기 전에
   * 디스크에 저장된 JSON을 readInstance로 읽으면 누락 상태가 가능하므로
   * downstream/import 경로의 타입 안전성을 위해 nullable로 모델링한다.
   * 누락 시 import는 `data.signatureHash ?? null`로 컬럼을 NULL로 박는다.
   */
  signatureHash: string | null;
  status: ApprovalStatus;
  approvalLine: ApprovalStep[];
  fields: FieldValue[];
  attachments: AttachmentInfo[];
  modificationHistory?: Array<{
    modifiedBy: UserInfo;
    modifiedAt: string;
    description?: string;
  }>;
  _raw?: unknown;
}
