import { z } from "zod";

// --- Zod 스키마 ---

const templateFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const userInfoInputSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  department: z.string().optional(),
  position: z.string().optional(),
});

const approvalStepInputSchema = z.object({
  order: z.number(),
  type: z.string(),
  approver: userInfoInputSchema,
  status: z.string(),
  processedAt: z.string().optional(),
  comment: z.string().optional(),
});

export const templateInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  fields: z.array(templateFieldSchema),
  defaultApprovalLine: z.array(approvalStepInputSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  permissions: z.record(z.unknown()).optional(),
  _raw: z.unknown().optional(),
});

const attachmentInfoInputSchema = z.object({
  fileName: z.string(),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
  localPath: z.string().optional(),
  downloadError: z.string().optional(),
});

const fieldValueInputSchema = z.object({
  fieldName: z.string(),
  fieldType: z.string(),
  value: z.unknown(),
});

const modificationHistorySchema = z.object({
  modifiedBy: userInfoInputSchema,
  modifiedAt: z.string(),
  description: z.string().optional(),
});

export const instanceInputSchema = z.object({
  id: z.string(),
  documentNumber: z.string().optional(),
  templateId: z.string(),
  templateName: z.string(),
  drafter: userInfoInputSchema,
  draftedAt: z.string(),
  status: z.string(),
  approvalLine: z.array(approvalStepInputSchema),
  fields: z.array(fieldValueInputSchema),
  attachments: z.array(attachmentInfoInputSchema),
  modificationHistory: z.array(modificationHistorySchema).optional(),
  _raw: z.unknown().optional(),
});

export const attendanceInputSchema = z.object({
  id: z.string(),
  type: z.string(),
  applicant: userInfoInputSchema,
  appliedAt: z.string(),
  details: z.record(z.unknown()),
  status: z.string(),
  approver: userInfoInputSchema.optional(),
  processedAt: z.string().optional(),
  _raw: z.unknown().optional(),
});

const crawlResultInputSchema = z.object({
  totalCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  errors: z.array(
    z.object({
      target: z.string(),
      phase: z.string(),
      message: z.string(),
      timestamp: z.string(),
    }),
  ),
  durationMs: z.number(),
});

export const crawlReportInputSchema = z.object({
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  templates: crawlResultInputSchema,
  instances: crawlResultInputSchema,
  attendance: crawlResultInputSchema,
  totalErrors: z.array(
    z.object({
      target: z.string(),
      phase: z.string(),
      message: z.string(),
      timestamp: z.string(),
    }),
  ),
});

// --- TypeScript 타입 (zod 추론) ---

export type TemplateField = z.infer<typeof templateFieldSchema>;
export type UserInfoInput = z.infer<typeof userInfoInputSchema>;
export type ApprovalStepInput = z.infer<typeof approvalStepInputSchema>;
export type TemplateInput = z.infer<typeof templateInputSchema>;
export type AttachmentInfoInput = z.infer<typeof attachmentInfoInputSchema>;
export type FieldValueInput = z.infer<typeof fieldValueInputSchema>;
export type InstanceInput = z.infer<typeof instanceInputSchema>;
export type AttendanceInput = z.infer<typeof attendanceInputSchema>;
export type CrawlResultInput = z.infer<typeof crawlResultInputSchema>;
export type CrawlReportInput = z.infer<typeof crawlReportInputSchema>;
