import type { CrawlReportInput } from "../types/input.js";
import type { SheetData, CellValue } from "../types/sheet.js";

/** 크롤 리포트 → 시트 변환 (FR-009) */
export function transformCrawlReport(report: CrawlReportInput | null): SheetData {
  const title = "크롤 리포트";
  const headers = ["항목", "값"];

  if (!report) {
    return {
      title,
      headers,
      rows: [["크롤 리포트 없음", ""]],
    };
  }

  const rows: CellValue[][] = [
    ["수집 시작 시각", report.startedAt],
    ["수집 종료 시각", report.completedAt],
    ["총 소요 시간(초)", Math.round(report.durationMs / 1000)],
    ["템플릿 - 전체", report.templates.totalCount],
    ["템플릿 - 성공", report.templates.successCount],
    ["템플릿 - 실패", report.templates.failureCount],
    ["인스턴스 - 전체", report.instances.totalCount],
    ["인스턴스 - 성공", report.instances.successCount],
    ["인스턴스 - 실패", report.instances.failureCount],
    ["근태/휴가 - 전체", report.attendance.totalCount],
    ["근태/휴가 - 성공", report.attendance.successCount],
    ["근태/휴가 - 실패", report.attendance.failureCount],
    ["총 오류 건수", report.totalErrors.length],
  ];

  // 오류가 존재하면 빈 행 이후 오류 목록 테이블 추가
  if (report.totalErrors.length > 0) {
    rows.push(["", ""]); // 빈 행
    rows.push(["대상", "단계", "메시지", "시각"] as CellValue[]); // 오류 목록 헤더
    for (const err of report.totalErrors) {
      rows.push([err.target, err.phase, err.message, err.timestamp] as CellValue[]);
    }
  }

  return { title, headers, rows };
}
