import type { ReadResult } from "../types/common.js";
import type { TransformResult } from "../types/sheet.js";
import { transformCrawlReport } from "./report.js";
import { transformTemplateList, transformTemplateFields } from "./templates.js";
import {
  transformInstanceList,
  transformInstanceFields,
  transformInstanceApprovalLines,
} from "./instances.js";
import { transformAttendanceList } from "./attendance.js";

/**
 * ReadResult를 SheetData 배열로 변환한다.
 * BR-001에 따라 7종의 시트를 생성한다.
 */
export function transformAll(readResult: ReadResult): TransformResult {
  return {
    sheets: [
      transformCrawlReport(readResult.crawlReport),
      transformTemplateList(readResult.templates),
      transformTemplateFields(readResult.templates),
      transformInstanceList(readResult.instances),
      transformInstanceFields(readResult.instances),
      transformInstanceApprovalLines(readResult.instances),
      transformAttendanceList(readResult.attendances),
    ],
  };
}
