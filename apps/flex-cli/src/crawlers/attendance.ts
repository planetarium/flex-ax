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
} from "./shared.js";

/**
 * 근태/휴가 승인 수집.
 *
 * 디스커버리 결과, 기존 하드코딩 API는 404:
 *   - /api/v2/time-off/users/me/time-off-requests
 *   - /api/v2/time-tracking/users/me/overtime-requests
 *   - /api/v2/time-tracking/users/me/work-change-requests
 *
 * 실제 API (카탈로그에서 발견):
 *   - GET /api/v2/time-off/users/{userId}/time-off-uses/by-use-date-range/{from}..{to}
 *     → timeOffUses[] 배열 반환
 */
export async function crawlAttendanceApprovals(
  authCtx: AuthContext,
  config: Config,
  _catalog: ApiCatalog | null,
  storage: StorageWriter,
  logger: Logger,
  collectedInstanceKeys: Set<string>,
): Promise<CrawlResult> {
  const startTime = Date.now();
  const result = emptyCrawlResult();

  logger.info("근태/휴가 승인 수집 시작");

  // 현재 사용자 ID를 먼저 확인
  const userId = await getUserId(authCtx, config, logger);
  if (!userId) {
    logger.error("사용자 ID를 확인할 수 없습니다");
    result.failureCount++;
    result.errors.push({
      target: "user-id-lookup",
      phase: "list",
      message: "사용자 ID 조회 실패 — workspace-users 응답에서 currentUser.user.userIdHash를 찾지 못함",
      timestamp: nowISO(),
    });
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // 최근 1년 범위로 휴가 사용 내역 조회
  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  const url = `${config.flexBaseUrl}/api/v2/time-off/users/${userId}/time-off-uses/by-use-date-range/${oneYearAgo}..${now}`;

  try {
    let continuationToken: string | undefined;
    let nextCursor: string | undefined;
    let pageNumber = 1;
    let hasMore = true;

    while (hasMore) {
      const pageUrl = buildTimeOffUsesUrl(url, continuationToken, nextCursor);
      const data = await withRetry(
        () => flexFetch<TimeOffUsesResponse>(authCtx, pageUrl),
        { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
      );

      const uses = data.timeOffUses ?? [];
      logger.info("휴가 사용 내역 페이지 수신", {
        page: pageNumber,
        usesInPage: uses.length,
        hasNext: data.hasNext ?? false,
        requestContinuationToken: continuationToken ?? null,
        requestNextCursor: nextCursor ?? null,
        nextContinuationToken: data.continuationToken ?? null,
        nextCursor: data.nextCursor ?? null,
      });

      for (const use of uses) {
        const id = use.userTimeOffRegisterEventId;
        if (!id) continue;

        if (collectedInstanceKeys.has(id)) {
          logger.info(`중복 스킵: ${id} (인스턴스에서 이미 수집)`);
          continue;
        }

        result.totalCount++;

        try {
          const approval: AttendanceApproval = {
            id,
            type: use.timeOffPolicyType ?? "TIME_OFF",
            applicant: {
              id: use.userIdHash,
              // 이름은 이 엔드포인트에서 제공되지 않으므로 비워둔다.
              // import 단계의 upsertUser가 placeholder로 등록하고,
              // 다른 엔드포인트에서 실제 이름이 들어오면 자동 갱신한다.
              name: "",
            },
            appliedAt: use.timeOffRegisterDateFrom ?? "",
            details: {
              dateFrom: use.timeOffRegisterDateFrom,
              dateTo: use.timeOffRegisterDateTo,
              days: use.useTime?.timeOffDays,
              minutes: use.useTime?.timeOffMinutes,
              policyType: use.timeOffPolicyType,
              canceled: use.canceled,
            },
            status: mapStatus(use.timeOffUseStatus, use.approvalStatus?.status),
            processedAt: use.timeOffRegisteredAt
              ? new Date(use.timeOffRegisteredAt).toISOString()
              : undefined,
            _raw: use,
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

      if (data.hasNext) {
        continuationToken = data.continuationToken;
        nextCursor = data.nextCursor;
        if (!continuationToken && !nextCursor) {
          logger.warn("hasNext=true 이지만 continuationToken/nextCursor 없음 — 페이지네이션 종료");
          hasMore = false;
        } else {
          pageNumber += 1;
        }
      } else {
        hasMore = false;
      }
    }
  } catch (error) {
    logger.warn("휴가 사용 내역 수집 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    result.errors.push({
      target: "time-off-uses",
      phase: "list",
      message: error instanceof Error ? error.message : String(error),
      timestamp: nowISO(),
    });
  }

  result.durationMs = Date.now() - startTime;
  logger.info(`\n근태/휴가 수집 완료: 성공 ${result.successCount}, 실패 ${result.failureCount}`);
  return result;
}

// --- 사용자 ID 조회 ---

async function getUserId(
  authCtx: AuthContext,
  config: Config,
  logger: Logger,
): Promise<string | null> {
  try {
    // /api/v2/core/me는 404이므로, workspace-users에서 currentUser를 가져옴.
    // 다른 크롤러 호출들과 동일하게 일시적 네트워크/서버 오류를 withRetry로 흡수한다.
    const data = await withRetry(
      () =>
        flexFetch<{
          currentUser?: { user?: { userIdHash?: string } };
        }>(
          authCtx,
          `${config.flexBaseUrl}/api/v2/core/users/me/workspace-users-corp-group-affiliates`,
        ),
      { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
    );
    const userId = data.currentUser?.user?.userIdHash ?? null;
    if (userId) {
      logger.info(`사용자 ID 확인: ${userId}`);
    }
    return userId;
  } catch (error) {
    logger.warn("사용자 정보 조회 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// --- flex API 응답 타입 ---

interface TimeOffUsesResponse {
  timeOffUses?: Array<{
    userTimeOffRegisterEventId: string;
    timeOffUseStatus: string;
    customerIdHash: string;
    userIdHash: string;
    timeOffRegisterDateFrom?: string;
    timeOffRegisterDateTo?: string;
    timeOffPolicyId?: string;
    timeOffPolicyType?: string;
    useTime?: {
      timeOffDays: number;
      timeOffMinutes: number;
      timeOffTimeAmount?: {
        days: number;
        hours: number;
        minutes: number;
      };
    };
    approvalStatus?: {
      status: string;
      taskKey?: string;
    };
    cancelApprovalInProgress?: boolean;
    timeOffRegisteredAt?: number;
    canceled?: boolean;
  }>;
  hasNext?: boolean;
  continuationToken?: string;
  nextCursor?: string;
}

function buildTimeOffUsesUrl(baseUrl: string, continuationToken?: string, nextCursor?: string): string {
  const url = new URL(baseUrl);
  if (continuationToken) url.searchParams.set("continuationToken", continuationToken);
  if (nextCursor) url.searchParams.set("nextCursor", nextCursor);
  return url.toString();
}

function mapStatus(useStatus?: string, approvalStatus?: string): string {
  const status = approvalStatus ?? useStatus ?? "unknown";
  const statusMap: Record<string, string> = {
    APPROVED: "approved",
    APPROVAL_COMPLETED: "approved",
    REJECTED: "rejected",
    CANCELED: "canceled",
    IN_PROGRESS: "in_progress",
    PENDING: "pending",
  };
  return statusMap[status] ?? status.toLowerCase();
}
