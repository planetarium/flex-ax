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
   */
  signatureHash: string;
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
