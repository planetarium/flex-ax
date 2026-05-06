import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrawlError } from "../types/common.js";
import type { AttendanceApproval } from "../types/attendance.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { WorkflowTemplate } from "../types/template.js";
import type { ApiCatalog } from "../types/catalog.js";
import type { CrawlResult } from "../crawlers/shared.js";

/**
 * customer 단위 증분 수집 워터마크. 도메인(예: `approvalDocuments`)별로
 * 그룹별 마지막 관측 `updatedAt` UTC ISO 문자열을 저장한다.
 *
 * 그룹별로 따로 두는 이유는 IN_PROGRESS와 DONE 그룹이 변동 패턴과 권장
 * overlap이 다르기 때문이다. `lastFullReconAt`은 도메인 공통이다.
 */
export interface WatermarkGroupState {
  lastUpdatedAt: string;
  /** 다음 실행 시 검색 from 날짜를 워터마크보다 N일 앞당긴다. flex의 date-단위 필터 잘림 보정용 */
  overlapDays: number;
  /** 마지막으로 이 그룹이 성공적으로 수집된 시각 (정보용) */
  lastSuccessfulRunAt: string;
}

export interface WatermarkDomainState {
  groups: Record<string, WatermarkGroupState>;
  lastFullReconAt?: string;
}

export interface WatermarkFile {
  [domain: string]: WatermarkDomainState | undefined;
}

export interface CrawlReport {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  templates: CrawlResult;
  instances: CrawlResult;
  attendance: CrawlResult;
  catalogEndpoints?: CrawlResult;
  totalErrors: CrawlError[];
}

export interface StorageWriter {
  saveTemplate(template: WorkflowTemplate): Promise<void>;
  saveInstance(instance: WorkflowInstance): Promise<void>;
  saveAttendanceApproval(approval: AttendanceApproval): Promise<void>;
  saveAttachment(instanceId: string, fileName: string, data: Buffer, fileKey?: string): Promise<string>;
  saveEndpointData(endpointId: string, data: unknown): Promise<void>;
  saveReport(report: CrawlReport): Promise<void>;
  saveCatalog(catalog: ApiCatalog): Promise<void>;
  loadWatermarks(): Promise<WatermarkFile>;
  saveWatermarks(file: WatermarkFile): Promise<void>;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function createStorageWriter(outputDir: string, catalogPath: string): StorageWriter {
  return {
    async saveTemplate(template) {
      const safeId = path.basename(template.id);
      await writeJson(path.join(outputDir, "templates", `${safeId}.json`), template);
    },

    async saveInstance(instance) {
      const safeId = path.basename(instance.id);
      await writeJson(path.join(outputDir, "instances", `${safeId}.json`), instance);
    },

    async saveAttendanceApproval(approval) {
      const safeId = path.basename(approval.id);
      await writeJson(path.join(outputDir, "attendance", `${safeId}.json`), approval);
    },

    async saveAttachment(instanceId, fileName, data, fileKey) {
      const safeInstanceId = path.basename(instanceId);
      const dir = path.join(outputDir, "attachments", safeInstanceId);
      await ensureDir(dir);
      const baseName = path.basename(fileName).replace(/[<>:"|?*]/g, "_") || "attachment";
      // fileKey가 있으면 prefix로 추가하여 동일 파일명 충돌 방지
      const safeName = fileKey ? `${path.basename(fileKey)}_${baseName}` : baseName;
      const filePath = path.join(dir, safeName);
      await writeFile(filePath, data);
      return filePath;
    },

    async saveEndpointData(endpointId, data) {
      const safeId = path.basename(endpointId).replace(/[<>:"|?*]/g, "_");
      await writeJson(path.join(outputDir, "endpoints", `${safeId}.json`), data);
    },

    async saveReport(report) {
      await writeJson(path.join(outputDir, "crawl-report.json"), report);
    },

    async saveCatalog(catalog) {
      await writeJson(catalogPath, catalog);
    },

    async loadWatermarks() {
      const watermarkPath = path.join(outputDir, "watermark.json");
      try {
        const content = await readFile(watermarkPath, "utf-8");
        const parsed = JSON.parse(content) as unknown;
        if (parsed && typeof parsed === "object") {
          return parsed as WatermarkFile;
        }
        return {};
      } catch {
        // 파일 없거나 깨진 경우 — 부트스트랩으로 처리
        return {};
      }
    },

    async saveWatermarks(file) {
      await writeJson(path.join(outputDir, "watermark.json"), file);
    },
  };
}
