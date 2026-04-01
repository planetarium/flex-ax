import type { TemplateInput, InstanceInput, AttendanceInput, CrawlReportInput } from "./input.js";

/** JSON 읽기 실패 항목 */
export interface ReadError {
  filePath: string;
  reason: string;
}

/** JSON 읽기 결과 */
export interface ReadResult {
  templates: TemplateInput[];
  instances: InstanceInput[];
  attendances: AttendanceInput[];
  crawlReport: CrawlReportInput | null;
  errors: ReadError[];
}

/** 업로드 결과 */
export interface UploadResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheets: Array<{
    title: string;
    rowCount: number;
  }>;
}
