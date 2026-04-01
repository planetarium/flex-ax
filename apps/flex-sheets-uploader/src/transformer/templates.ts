import type { TemplateInput } from "../types/input.js";
import type { SheetData, CellValue } from "../types/sheet.js";

/** 템플릿 목록 → 시트 변환 (FR-003) */
export function transformTemplateList(templates: TemplateInput[]): SheetData {
  const title = "템플릿 목록";
  const headers = ["템플릿 ID", "템플릿 이름", "카테고리", "필드 수", "생성일", "수정일"];

  const rows: CellValue[][] = templates.map((t) => [
    t.id,
    t.name,
    t.category ?? "",
    t.fields.length,
    t.createdAt ?? "",
    t.updatedAt ?? "",
  ]);

  return { title, headers, rows };
}

/** 템플릿 필드 정의 → 시트 변환 (FR-004) */
export function transformTemplateFields(templates: TemplateInput[]): SheetData {
  const title = "템플릿 필드 정의";
  const headers = [
    "템플릿 ID",
    "템플릿 이름",
    "필드 이름",
    "필드 유형",
    "필수 여부",
    "옵션 목록",
    "설명",
  ];

  const rows: CellValue[][] = [];

  for (const t of templates) {
    for (const f of t.fields) {
      rows.push([
        t.id,
        t.name,
        f.name,
        f.type,
        f.required != null ? String(f.required) : "",
        f.options ? f.options.join(", ") : "",
        f.description ?? "",
      ]);
    }
  }

  return { title, headers, rows };
}
