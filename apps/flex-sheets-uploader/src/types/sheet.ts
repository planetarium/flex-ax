/** 셀 값 타입 (Google Sheets API에 전달) */
export type CellValue = string | number | boolean | null;

/** 단일 시트의 변환 결과 */
export interface SheetData {
  /** 시트(탭) 이름 */
  title: string;
  /** 첫 번째 행: 열 이름(헤더) */
  headers: string[];
  /** 두 번째 행부터: 데이터 행 */
  rows: CellValue[][];
}

/** 전체 변환 결과 */
export interface TransformResult {
  /** 시트 데이터 목록 (순서대로 업로드) */
  sheets: SheetData[];
}
