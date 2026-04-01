import type { ApprovalStep } from "./common.js";

/** 양식 필드 정의 */
export interface TemplateField {
  name: string;
  type: string;
  required?: boolean;
  options?: string[];
  description?: string;
}

/** 워크플로우 양식(템플릿) */
export interface WorkflowTemplate {
  id: string;
  name: string;
  category?: string;
  fields: TemplateField[];
  defaultApprovalLine?: ApprovalStep[];
  createdAt?: string;
  updatedAt?: string;
  permissions?: Record<string, unknown>;
  _raw?: unknown;
}
