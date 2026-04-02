import type { AuthContext } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { StorageWriter } from "../storage/index.js";
import type { ApiCatalog } from "../types/catalog.js";
import type { AttendanceApproval } from "../types/attendance.js";
import {
  type CrawlResult,
  delay,
  emptyCrawlResult,
  nowISO,
  withRetry,
  flexFetch,
  resolveUrl,
} from "./shared.js";

const ATTENDANCE_ENDPOINTS = [
  { id: "timeoff-requests", fallback: "/api/v2/time-off/users/me/time-off-requests" },
  { id: "overtime-requests", fallback: "/api/v2/time-tracking/users/me/overtime-requests" },
  { id: "workchange-requests", fallback: "/api/v2/time-tracking/users/me/work-change-requests" },
] as const;

export async function crawlAttendanceApprovals(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  storage: StorageWriter,
  logger: Logger,
  collectedInstanceKeys: Set<string>,
): Promise<CrawlResult> {
  const startTime = Date.now();
  const result = emptyCrawlResult();

  logger.info("근태/휴가 승인 수집 시작");

  for (const endpoint of ATTENDANCE_ENDPOINTS) {
    const url = resolveUrl(config.flexBaseUrl, catalog, endpoint.id, endpoint.fallback);

    try {
      const data = await withRetry(
        () => flexFetch<Record<string, unknown>>(authCtx, url),
        { maxRetries: 1, delayMs: config.requestDelayMs },
      );

      const items = extractItems(data);
      logger.info(`${endpoint.id}: ${items.length}건 발견`);

      for (const item of items) {
        const id = String(item.id ?? item.requestId ?? item.idHash ?? "");
        if (!id) continue;

        if (collectedInstanceKeys.has(id)) {
          logger.info(`중복 스킵: ${id} (인스턴스에서 이미 수집)`);
          continue;
        }

        result.totalCount++;

        try {
          const approval: AttendanceApproval = {
            id,
            type: String(item.type ?? item.category ?? endpoint.id),
            applicant: {
              name: String((item.applicant as Record<string, unknown>)?.name ?? (item.requester as Record<string, unknown>)?.name ?? "unknown"),
              id: String((item.applicant as Record<string, unknown>)?.idHash ?? ""),
            },
            appliedAt: String(item.appliedAt ?? item.requestedAt ?? item.createdAt ?? ""),
            details: extractDetails(item),
            status: String(item.status ?? "unknown"),
            approver: item.approver ? {
              name: String((item.approver as Record<string, unknown>).name ?? ""),
            } : undefined,
            processedAt: item.processedAt ? String(item.processedAt) : undefined,
            _raw: item,
          };

          await storage.saveAttendanceApproval(approval);
          result.successCount++;
        } catch (error) {
          result.failureCount++;
          result.errors.push({
            target: `attendance:${id}`,
            phase: "detail",
            message: error instanceof Error ? error.message : String(error),
            timestamp: nowISO(),
          });
        }

        await delay(config.requestDelayMs);
      }
    } catch (error) {
      logger.warn(`${endpoint.id} 접근 실패 (스킵)`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  result.durationMs = Date.now() - startTime;
  logger.info(`\n근태/휴가 수집 완료: 성공 ${result.successCount}, 실패 ${result.failureCount}`);
  return result;
}

function extractItems(data: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) return data[key] as Array<Record<string, unknown>>;
  }
  if (data.data && typeof data.data === "object") {
    const inner = data.data as Record<string, unknown>;
    for (const key of Object.keys(inner)) {
      if (Array.isArray(inner[key])) return inner[key] as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function extractDetails(item: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const keys = [
    "targetDate", "startDate", "endDate", "startAt", "endAt",
    "workType", "leaveType", "timeOffType", "reason", "memo",
    "duration", "hours", "days", "shiftType",
  ];
  for (const key of keys) {
    if (item[key] !== undefined) details[key] = item[key];
  }
  return details;
}
