import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrawlError } from "../types/common.js";
import type { AttendanceApproval } from "../types/attendance.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { WorkflowTemplate } from "../types/template.js";
import type { ApiCatalog } from "../types/catalog.js";
import type { CrawlResult } from "../crawlers/shared.js";

export interface CrawlReport {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  templates: CrawlResult;
  instances: CrawlResult;
  attendance: CrawlResult;
  totalErrors: CrawlError[];
}

export interface StorageWriter {
  saveTemplate(template: WorkflowTemplate): Promise<void>;
  saveInstance(instance: WorkflowInstance): Promise<void>;
  saveAttendanceApproval(approval: AttendanceApproval): Promise<void>;
  saveAttachment(instanceId: string, fileName: string, data: Buffer): Promise<string>;
  saveReport(report: CrawlReport): Promise<void>;
  saveCatalog(catalog: ApiCatalog): Promise<void>;
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

    async saveAttachment(instanceId, fileName, data) {
      const safeInstanceId = path.basename(instanceId);
      const dir = path.join(outputDir, "attachments", safeInstanceId);
      await ensureDir(dir);
      const safeName = path.basename(fileName).replace(/[<>:"|?*]/g, "_") || "attachment";
      const filePath = path.join(dir, safeName);
      await writeFile(filePath, data);
      return filePath;
    },

    async saveReport(report) {
      await writeJson(path.join(outputDir, "crawl-report.json"), report);
    },

    async saveCatalog(catalog) {
      await writeJson(catalogPath, catalog);
    },
  };
}
