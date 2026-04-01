import type { CrawlReport } from "../storage/index.js";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  progress(phase: string, current: number, total?: number): void;
  summary(report: CrawlReport): void;
}

const SENSITIVE_KEYS = ["password", "token", "cookie", "authorization", "secret"];

function sanitize(meta: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k))) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function timestamp(): string {
  return new Date().toISOString();
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return " " + JSON.stringify(sanitize(meta));
}

export function createLogger(): Logger {
  return {
    info(message, meta) {
      console.log(`[${timestamp()}] INFO  ${message}${formatMeta(meta)}`);
    },
    warn(message, meta) {
      console.warn(`[${timestamp()}] WARN  ${message}${formatMeta(meta)}`);
    },
    error(message, meta) {
      console.error(`[${timestamp()}] ERROR ${message}${formatMeta(meta)}`);
    },
    progress(phase, current, total) {
      const totalStr = total != null ? `/${total}` : "";
      process.stdout.write(`\r[${timestamp()}] ${phase}: ${current}${totalStr}`);
    },
    summary(report) {
      console.log("\n");
      console.log("=".repeat(60));
      console.log("  수집 결과 요약");
      console.log("=".repeat(60));
      console.log(`  시작: ${report.startedAt}`);
      console.log(`  완료: ${report.completedAt}`);
      console.log(`  소요: ${(report.durationMs / 1000).toFixed(1)}s`);
      console.log("-".repeat(60));
      console.log(
        `  양식(템플릿):  성공 ${report.templates.successCount} / 실패 ${report.templates.failureCount}`,
      );
      console.log(
        `  인스턴스:      성공 ${report.instances.successCount} / 실패 ${report.instances.failureCount}`,
      );
      console.log(
        `  근태/휴가:     성공 ${report.attendance.successCount} / 실패 ${report.attendance.failureCount}`,
      );
      console.log("-".repeat(60));
      console.log(`  총 에러: ${report.totalErrors.length}건`);
      console.log("=".repeat(60));
    },
  };
}
