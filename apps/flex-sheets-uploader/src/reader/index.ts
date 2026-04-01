import { readdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { ZodSchema } from "zod";
import {
  templateInputSchema,
  instanceInputSchema,
  attendanceInputSchema,
  crawlReportInputSchema,
} from "../types/input.js";
import type {
  TemplateInput,
  InstanceInput,
  AttendanceInput,
  CrawlReportInput,
} from "../types/input.js";
import type { ReadError, ReadResult } from "../types/common.js";
import type { Logger } from "../logger/index.js";

/**
 * 디렉토리 내 *.json 파일을 읽고 zod 스키마로 검증한다.
 * 파싱/검증 실패 파일은 건너뛰고 errors에 기록한다.
 */
async function readJsonDir<T>(
  dirPath: string,
  schema: ZodSchema<T>,
  logger: Logger,
  errors: ReadError[],
): Promise<T[]> {
  let exists = true;
  try {
    await access(dirPath);
  } catch {
    exists = false;
  }

  if (!exists) {
    logger.warn(`디렉토리가 존재하지 않습니다: ${dirPath}`);
    return [];
  }

  const entries = await readdir(dirPath);
  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();

  if (jsonFiles.length === 0) {
    logger.warn(`디렉토리에 JSON 파일이 없습니다: ${dirPath}`);
    return [];
  }

  const results: T[] = [];

  for (const file of jsonFiles) {
    const filePath = join(dirPath, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      const validated = schema.parse(parsed);
      results.push(validated);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push({ filePath, reason });
      logger.warn(`파일 읽기/검증 실패, 건너뜁니다: ${filePath}`, { reason });
    }
  }

  return results;
}

/**
 * 지정된 input 경로에서 flex-crawler output 데이터를 읽는다.
 *
 * - templates/*.json, instances/*.json, attendance/*.json을 각각 읽고 파싱한다
 * - crawl-report.json을 읽는다 (없으면 null)
 * - 파싱 실패 파일은 건너뛰고 errors 배열에 기록한다 (FR-001, NFR-005)
 * - 유효성 검증: zod 스키마로 필수 필드 존재 여부를 확인한다
 */
export async function readInputData(
  inputPath: string,
  logger: Logger,
): Promise<ReadResult> {
  // 입력 경로 존재 여부 확인
  try {
    await access(inputPath);
  } catch {
    throw new Error(`입력 경로가 존재하지 않습니다: ${inputPath}`);
  }

  const errors: ReadError[] = [];

  logger.info("JSON 데이터 읽기 시작...", { inputPath });

  // 템플릿 읽기
  const templates = await readJsonDir<TemplateInput>(
    join(inputPath, "templates"),
    templateInputSchema,
    logger,
    errors,
  );
  logger.info(`템플릿 읽기 완료: ${templates.length}건`);

  // 인스턴스 읽기
  const instances = await readJsonDir<InstanceInput>(
    join(inputPath, "instances"),
    instanceInputSchema,
    logger,
    errors,
  );
  logger.info(`인스턴스 읽기 완료: ${instances.length}건`);

  // 근태/휴가 승인 읽기
  const attendances = await readJsonDir<AttendanceInput>(
    join(inputPath, "attendance"),
    attendanceInputSchema,
    logger,
    errors,
  );
  logger.info(`근태/휴가 승인 읽기 완료: ${attendances.length}건`);

  // 크롤 리포트 읽기
  let crawlReport: CrawlReportInput | null = null;
  const reportPath = join(inputPath, "crawl-report.json");
  try {
    const content = await readFile(reportPath, "utf-8");
    const parsed = JSON.parse(content);
    crawlReport = crawlReportInputSchema.parse(parsed);
    logger.info("크롤 리포트 읽기 완료");
  } catch {
    logger.warn("crawl-report.json을 읽을 수 없습니다. 크롤 리포트 없이 진행합니다.");
  }

  if (errors.length > 0) {
    logger.warn(`JSON 읽기 중 ${errors.length}건의 오류가 발생했습니다.`);
  }

  return { templates, instances, attendances, crawlReport, errors };
}
