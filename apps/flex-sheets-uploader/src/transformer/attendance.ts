import type { AttendanceInput } from "../types/input.js";
import type { SheetData, CellValue } from "../types/sheet.js";

/** 근태/휴가 승인 → 시트 변환 (FR-008) */
export function transformAttendanceList(attendances: AttendanceInput[]): SheetData {
  const title = "근태/휴가 승인";
  const headers = [
    "승인 ID",
    "유형",
    "신청자 이름",
    "신청자 부서",
    "신청일",
    "상태",
    "승인자 이름",
    "처리 일시",
    "상세 정보",
  ];

  const rows: CellValue[][] = attendances.map((a) => [
    a.id,
    a.type,
    a.applicant.name,
    a.applicant.department ?? "",
    a.appliedAt,
    a.status,
    a.approver?.name ?? "",
    a.processedAt ?? "",
    JSON.stringify(a.details),
  ]);

  return { title, headers, rows };
}
