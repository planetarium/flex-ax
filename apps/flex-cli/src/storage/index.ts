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
  /**
   * 다음 실행 시 검색 from 날짜를 워터마크보다 N일 앞당긴다. flex의 date-단위 필터 잘림 보정용.
   * Optional — 누락 시 호출자가 group 단위 default를 사용한다.
   */
  overlapDays?: number;
  /**
   * 마지막으로 이 그룹이 성공적으로 수집된 시각 (정보용). Optional — 사용자가
   * watermark.json을 손으로 편집할 때 이 필드를 빠뜨려도 워터마크 자체는 살린다.
   */
  lastSuccessfulRunAt?: string;
}

/** overlapDays로 받아들일 수 있는 정수 상한. 그 이상은 손상으로 간주해 default fallback. */
const MAX_OVERLAP_DAYS = 365;

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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 손상되거나 사람이 손댄 watermark.json을 안전한 shape으로 정규화한다.
 * 의도적으로 관대하다(스키마 위반은 조용히 누락) — 워터마크는 손실되어도
 * 부트스트랩 풀크롤로 자가복구되므로 크롤 전체를 중단시키는 것보다 낫다.
 */
export function normalizeWatermarkFile(parsed: unknown): WatermarkFile {
  if (!isPlainObject(parsed)) return {};
  const out: WatermarkFile = {};
  for (const [domain, rawState] of Object.entries(parsed)) {
    if (!isPlainObject(rawState)) continue;
    const groupsCandidate = (rawState as Record<string, unknown>).groups;
    const groups: Record<string, WatermarkGroupState> = {};
    if (isPlainObject(groupsCandidate)) {
      for (const [label, rawGroup] of Object.entries(groupsCandidate)) {
        if (!isPlainObject(rawGroup)) continue;
        const lastUpdatedAt = rawGroup.lastUpdatedAt;
        // lastUpdatedAt만이 워터마크의 본질. 나머지는 누락/이상값이면 omit해서
        // 호출자가 default로 폴백하게 한다 (=그룹 자체를 잃지 않는다).
        // 빈 문자열/공백은 영구적으로 unusable하므로 그룹째 드롭한다.
        if (typeof lastUpdatedAt !== "string" || lastUpdatedAt.trim().length === 0) {
          continue;
        }
        const group: WatermarkGroupState = { lastUpdatedAt };
        const overlapDays = rawGroup.overlapDays;
        if (
          typeof overlapDays === "number" &&
          Number.isInteger(overlapDays) &&
          overlapDays >= 0 &&
          overlapDays <= MAX_OVERLAP_DAYS
        ) {
          group.overlapDays = overlapDays;
        }
        const lastSuccessfulRunAt = rawGroup.lastSuccessfulRunAt;
        if (typeof lastSuccessfulRunAt === "string") {
          group.lastSuccessfulRunAt = lastSuccessfulRunAt;
        }
        groups[label] = group;
      }
    }
    const lastFullReconAt = (rawState as Record<string, unknown>).lastFullReconAt;
    out[domain] = {
      groups,
      lastFullReconAt: typeof lastFullReconAt === "string" ? lastFullReconAt : undefined,
    };
  }
  return out;
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
      let content: string;
      try {
        content = await readFile(watermarkPath, "utf-8");
      } catch (err) {
        // 파일 없음(ENOENT) — 정상적인 부트스트랩 시나리오. silent fallback.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
        // 권한/디스크/디렉토리 충돌 등 기타 I/O 에러는 surface해서 호출자가
        // 인지하게 한다. 침묵 부트스트랩은 이전에 잘 채워둔 워터마크를
        // 모르고 덮어쓰는 위험이 있다.
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // 손상된 JSON은 부트스트랩으로 폴백. 다음 정상 실행에서 새로 채워진다.
        return {};
      }
      return normalizeWatermarkFile(parsed);
    },

    async saveWatermarks(file) {
      await writeJson(path.join(outputDir, "watermark.json"), file);
    },
  };
}
