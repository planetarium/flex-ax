import type { InstanceInput } from "../types/input.js";
import type { SheetData, CellValue } from "../types/sheet.js";

/**
 * 값을 셀 값으로 변환한다.
 * 객체/배열은 JSON.stringify로 직렬화한다 (BR-004).
 */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  return JSON.stringify(value);
}

/** 인스턴스 목록 → 시트 변환 (FR-005) */
export function transformInstanceList(instances: InstanceInput[]): SheetData {
  const title = "인스턴스 목록";
  const headers = [
    "인스턴스 ID",
    "문서번호",
    "템플릿 ID",
    "템플릿 이름",
    "기안자 이름",
    "기안자 부서",
    "작성일",
    "결재 상태",
    "결재선 단계 수",
    "첨부파일 수",
  ];

  const rows: CellValue[][] = instances.map((inst) => [
    inst.id,
    inst.documentNumber ?? "",
    inst.templateId,
    inst.templateName,
    inst.drafter.name,
    inst.drafter.department ?? "",
    inst.draftedAt,
    inst.status,
    inst.approvalLine.length,
    inst.attachments.length,
  ]);

  return { title, headers, rows };
}

/** 인스턴스 필드 값 → 시트 변환 (FR-006) */
export function transformInstanceFields(instances: InstanceInput[]): SheetData {
  const title = "인스턴스 필드 값";
  const headers = ["인스턴스 ID", "문서번호", "필드 이름", "필드 유형", "필드 값"];

  const rows: CellValue[][] = [];

  for (const inst of instances) {
    for (const f of inst.fields) {
      rows.push([
        inst.id,
        inst.documentNumber ?? "",
        f.fieldName,
        f.fieldType,
        toCellValue(f.value),
      ]);
    }
  }

  return { title, headers, rows };
}

/** 인스턴스 결재선 → 시트 변환 (FR-007) */
export function transformInstanceApprovalLines(instances: InstanceInput[]): SheetData {
  const title = "인스턴스 결재선";
  const headers = [
    "인스턴스 ID",
    "문서번호",
    "단계 순서",
    "승인 유형",
    "승인자 이름",
    "승인자 부서",
    "승인 상태",
    "처리 일시",
    "코멘트",
  ];

  const rows: CellValue[][] = [];

  for (const inst of instances) {
    for (const step of inst.approvalLine) {
      rows.push([
        inst.id,
        inst.documentNumber ?? "",
        step.order,
        step.type,
        step.approver.name,
        step.approver.department ?? "",
        step.status,
        step.processedAt ?? "",
        step.comment ?? "",
      ]);
    }
  }

  return { title, headers, rows };
}
