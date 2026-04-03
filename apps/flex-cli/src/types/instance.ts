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
