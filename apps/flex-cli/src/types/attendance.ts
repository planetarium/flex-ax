import type { ApprovalStatus, UserInfo } from "./common.js";

/** 근태/휴가 승인 이력 */
export interface AttendanceApproval {
  id: string;
  type: string;
  applicant: UserInfo;
  appliedAt: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  approver?: UserInfo;
  processedAt?: string;
  _raw?: unknown;
}
