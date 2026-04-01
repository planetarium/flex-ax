import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrawlError } from "../types/common.js";
import type { AttendanceApproval } from "../types/attendance.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { WorkflowTemplate } from "../types/template.js";
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
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function createStorageWriter(outputDir: string): StorageWriter {
  return {
    async saveTemplate(template) {
      const filePath = path.join(outputDir, "templates", `${template.id}.json`);
      await writeJson(filePath, template);
    },

    async saveInstance(instance) {
      const filePath = path.join(outputDir, "instances", `${instance.id}.json`);
      await writeJson(filePath, instance);
    },

    async saveAttendanceApproval(approval) {
      const filePath = path.join(outputDir, "attendance", `${approval.id}.json`);
      await writeJson(filePath, approval);
    },

    async saveAttachment(instanceId, fileName, data) {
      const dir = path.join(outputDir, "attachments", instanceId);
      await ensureDir(dir);
      const filePath = path.join(dir, fileName);
      await writeFile(filePath, data);
      return filePath;
    },

    async saveReport(report) {
      const filePath = path.join(outputDir, "crawl-report.json");
      await writeJson(filePath, report);
    },
  };
}
