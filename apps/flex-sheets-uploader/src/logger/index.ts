export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const SENSITIVE_KEYS = ["password", "token", "cookie", "authorization", "secret", "key"];

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
  };
}
