import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  progress(phase: string, current: number, total?: number): void;
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

function resolveLogFilePath(): string {
  return path.resolve(process.env.FLEX_AX_LOG_FILE || "./output/flex-ax.log");
}

function writeLogLine(line: string): void {
  const logFilePath = resolveLogFilePath();
  mkdirSync(path.dirname(logFilePath), { recursive: true });
  appendFileSync(logFilePath, `${line}\n`, "utf-8");
}

export function createLogger(prefix?: string): Logger {
  const tag = prefix ? `[FLEX-AX:${prefix}]` : "";

  // 모든 진행 로그(info/warn/error/progress)는 stderr로 보낸다.
  // stdout은 명령의 "결과물"(query 결과 JSON, workflow describe YAML, workflow templates 목록 등)
  // 전용으로 남겨야 redirect/pipe 시 결과물이 로그로 오염되지 않는다.
  return {
    info(message, meta) {
      const line = `[${timestamp()}] INFO  ${tag} ${message}${formatMeta(meta)}`;
      process.stderr.write(`${line}\n`);
      writeLogLine(line);
    },
    warn(message, meta) {
      const line = `[${timestamp()}] WARN  ${tag} ${message}${formatMeta(meta)}`;
      process.stderr.write(`${line}\n`);
      writeLogLine(line);
    },
    error(message, meta) {
      const line = `[${timestamp()}] ERROR ${tag} ${message}${formatMeta(meta)}`;
      process.stderr.write(`${line}\n`);
      writeLogLine(line);
    },
    progress(phase, current, total) {
      const totalStr = total != null ? `/${total}` : "";
      const line = `[${timestamp()}] ${phase}: ${current}${totalStr}`;
      process.stderr.write(`\r${line}`);
      writeLogLine(line);
    },
  };
}
