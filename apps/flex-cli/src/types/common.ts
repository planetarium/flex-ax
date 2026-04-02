/** 결재 상태 */
export type ApprovalStatus =
  | "pending"
  | "in_progress"
  | "approved"
  | "rejected"
  | "canceled"
  | (string & {});

/** 사용자 정보 (기안자, 승인자 등) */
export interface UserInfo {
  id?: string;
  name: string;
  department?: string;
  position?: string;
}

/** 결재선 단계 */
export interface ApprovalStep {
  order: number;
  type: string;
  approver: UserInfo;
  status: ApprovalStatus;
  processedAt?: string;
  comment?: string;
}

/** 첨부파일 정보 */
export interface AttachmentInfo {
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  localPath?: string;
  downloadError?: string;
}

/** 필드 값 */
export interface FieldValue {
  fieldName: string;
  fieldType: string;
  value: unknown;
}

/** 수집 실패 항목 */
export interface CrawlError {
  target: string;
  phase: string;
  message: string;
  timestamp: string;
}
