import { withRetry, flexFetch } from "../crawlers/shared.js";
import { withLiveCommandContext } from "./live-common.js";

interface AttendanceOpts {
  customer?: string;
  from?: string;
  to?: string;
  status?: string;
  type?: string;
  limit: number;
  positional: string[];
}

interface TimeOffUse {
  userTimeOffRegisterEventId: string;
  timeOffUseStatus?: string;
  customerIdHash: string;
  userIdHash: string;
  timeOffRegisterDateFrom?: string;
  timeOffRegisterDateTo?: string;
  timeOffPolicyId?: string;
  timeOffPolicyType?: string;
  useTime?: {
    timeOffDays?: number;
    timeOffMinutes?: number;
  };
  approvalStatus?: {
    status?: string;
    taskKey?: string;
  };
  cancelApprovalInProgress?: boolean;
  timeOffRegisteredAt?: number;
  canceled?: boolean;
}

interface TimeOffUsesResponse {
  timeOffUses?: TimeOffUse[];
  hasNext?: boolean;
  continuationToken?: string;
  nextCursor?: string;
}

export async function runAttendance(argv: string[] = process.argv.slice(3)): Promise<void> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "list":
      await cmdList(rest);
      return;
    case "show":
      await cmdShow(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      process.exit(sub === undefined ? 1 : 0);
    default:
      console.error(`[FLEX-AX:ATTENDANCE:ERROR] 알 수 없는 서브커맨드: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: flex-ax attendance <subcommand>

Subcommands:
  list                          내 휴가/근태 사용 내역 조회
  show <eventId>                특정 휴가/근태 이벤트 상세 조회

Options:
  --customer <customerIdHash>   대상 법인 지정
  --from <YYYY-MM-DD>           조회 시작일 (기본: 오늘 기준 1년 전)
  --to <YYYY-MM-DD>             조회 종료일 (기본: 오늘)
  --status <status>             상태 필터 (approved, pending, ...)
  --type <type>                 유형 필터 (ANNUAL, CUSTOM, ...)
  --limit <n>                   최대 결과 수 (기본: 100)

Examples:
  flex-ax attendance list
  flex-ax attendance list --from 2026-01-01 --to 2026-04-30 --status approved
  flex-ax attendance show abc123
`);
}

function parseOpts(args: string[], defaultLimit: number): AttendanceOpts {
  const opts: AttendanceOpts = { limit: defaultLimit, positional: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--customer") {
      opts.customer = args[++i];
    } else if (arg === "--from") {
      opts.from = args[++i];
    } else if (arg === "--to") {
      opts.to = args[++i];
    } else if (arg === "--status") {
      opts.status = args[++i];
    } else if (arg === "--type") {
      opts.type = args[++i];
    } else if (arg === "--limit") {
      const value = Number.parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit은 1 이상의 정수여야 합니다.");
      }
      opts.limit = value;
    } else {
      opts.positional.push(arg);
    }
  }

  return opts;
}

async function cmdList(args: string[]): Promise<void> {
  const opts = parseOpts(args, 100);
  await withLiveCommandContext("ATTENDANCE", opts, async ({ authCtx, config }) => {
    const userId = await getCurrentUserId(authCtx, config.flexBaseUrl, config.maxRetries, config.requestDelayMs);
    const records = await collectAttendanceRecords(authCtx, config.flexBaseUrl, userId, {
      from: opts.from,
      to: opts.to,
      status: opts.status,
      type: opts.type,
      limit: opts.limit,
      maxRetries: config.maxRetries,
      delayMs: config.requestDelayMs,
    });
    console.log(JSON.stringify(records.map(toAttendanceSummary), null, 2));
  });
}

async function cmdShow(args: string[]): Promise<void> {
  const opts = parseOpts(args, 1000);
  const eventId = opts.positional[0];
  if (!eventId) {
    console.error("[FLEX-AX:ATTENDANCE:ERROR] show 대상 eventId를 지정하세요.");
    process.exit(1);
  }

  await withLiveCommandContext("ATTENDANCE", opts, async ({ authCtx, config }) => {
    const userId = await getCurrentUserId(authCtx, config.flexBaseUrl, config.maxRetries, config.requestDelayMs);
    const records = await collectAttendanceRecords(authCtx, config.flexBaseUrl, userId, {
      from: opts.from,
      to: opts.to,
      status: undefined,
      type: undefined,
      limit: Math.max(opts.limit, 1000),
      maxRetries: config.maxRetries,
      delayMs: config.requestDelayMs,
    });
    const found = records.find((record) => record.userTimeOffRegisterEventId === eventId);
    if (!found) {
      console.error(`[FLEX-AX:ATTENDANCE:ERROR] 이벤트를 찾을 수 없습니다: ${eventId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(toAttendanceDetail(found), null, 2));
  });
}

async function getCurrentUserId(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  maxRetries: number,
  delayMs: number,
): Promise<string> {
  const data = await withRetry(
    () =>
      flexFetch<{
        currentUser?: { user?: { userIdHash?: string } };
      }>(
        authCtx,
        `${baseUrl}/api/v2/core/users/me/workspace-users-corp-group-affiliates`,
      ),
    { maxRetries, delayMs },
  );
  const userId = data.currentUser?.user?.userIdHash;
  if (!userId) {
    throw new Error("현재 사용자 ID를 확인할 수 없습니다.");
  }
  return userId;
}

async function collectAttendanceRecords(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  userId: string,
  opts: {
    from?: string;
    to?: string;
    status?: string;
    type?: string;
    limit: number;
    maxRetries: number;
    delayMs: number;
  },
): Promise<TimeOffUse[]> {
  const basePath = `${baseUrl}/api/v2/time-off/users/${userId}/time-off-uses/by-use-date-range/${toEpochMs(
    opts.from,
    true,
  )}..${toEpochMs(opts.to, false)}`;

  const normalizedStatus = opts.status?.trim().toLowerCase();
  const normalizedType = opts.type?.trim().toUpperCase();
  const collected: TimeOffUse[] = [];
  let continuationToken: string | undefined;
  let nextCursor: string | undefined;
  let hasMore = true;

  while (hasMore && collected.length < opts.limit) {
    const url = buildTimeOffUsesUrl(basePath, continuationToken, nextCursor);
    const page = await withRetry(
      () => flexFetch<TimeOffUsesResponse>(authCtx, url),
      { maxRetries: opts.maxRetries, delayMs: opts.delayMs },
    );

    for (const record of page.timeOffUses ?? []) {
      if (normalizedStatus && mapStatus(record) !== normalizedStatus) continue;
      if (normalizedType && (record.timeOffPolicyType ?? "").toUpperCase() !== normalizedType) continue;
      collected.push(record);
      if (collected.length >= opts.limit) break;
    }

    if (!page.hasNext || collected.length >= opts.limit) {
      hasMore = false;
      continue;
    }

    const nextContinuationToken = page.continuationToken ?? continuationToken;
    const nextPageCursor = page.nextCursor ?? nextCursor;
    if (!nextContinuationToken && !nextPageCursor) {
      hasMore = false;
      continue;
    }
    if (nextContinuationToken === continuationToken && nextPageCursor === nextCursor) {
      hasMore = false;
      continue;
    }
    continuationToken = nextContinuationToken;
    nextCursor = nextPageCursor;
  }

  return collected;
}

function toAttendanceSummary(record: TimeOffUse): Record<string, unknown> {
  return {
    id: record.userTimeOffRegisterEventId,
    status: mapStatus(record),
    type: record.timeOffPolicyType ?? null,
    dateFrom: record.timeOffRegisterDateFrom ?? null,
    dateTo: record.timeOffRegisterDateTo ?? null,
    days: record.useTime?.timeOffDays ?? null,
    minutes: record.useTime?.timeOffMinutes ?? null,
    canceled: record.canceled ?? false,
    approvalTaskKey: record.approvalStatus?.taskKey ?? null,
  };
}

function toAttendanceDetail(record: TimeOffUse): Record<string, unknown> {
  return {
    ...toAttendanceSummary(record),
    customerIdHash: record.customerIdHash,
    userIdHash: record.userIdHash,
    policyId: record.timeOffPolicyId ?? null,
    approvalStatus: record.approvalStatus ?? null,
    cancelApprovalInProgress: record.cancelApprovalInProgress ?? false,
    processedAt:
      typeof record.timeOffRegisteredAt === "number"
        ? new Date(record.timeOffRegisteredAt).toISOString()
        : null,
    raw: record,
  };
}

function buildTimeOffUsesUrl(baseUrl: string, continuationToken?: string, nextCursor?: string): string {
  const url = new URL(baseUrl);
  if (continuationToken) url.searchParams.set("continuationToken", continuationToken);
  if (nextCursor) url.searchParams.set("nextCursor", nextCursor);
  return url.toString();
}

function toEpochMs(input: string | undefined, startOfDay: boolean): number {
  if (!input) {
    const now = new Date();
    if (startOfDay) {
      const oneYearAgo = new Date(now);
      oneYearAgo.setFullYear(now.getFullYear() - 1);
      oneYearAgo.setHours(0, 0, 0, 0);
      return oneYearAgo.getTime();
    }
    now.setHours(23, 59, 59, 999);
    return now.getTime();
  }

  const date = new Date(`${input}T00:00:00${startOfDay ? "" : ""}`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`날짜 형식이 잘못되었습니다: ${input}`);
  }
  if (startOfDay) {
    date.setHours(0, 0, 0, 0);
  } else {
    date.setHours(23, 59, 59, 999);
  }
  return date.getTime();
}

function mapStatus(record: TimeOffUse): string {
  const raw = record.approvalStatus?.status ?? record.timeOffUseStatus ?? "unknown";
  const normalized = raw.toUpperCase();
  const statusMap: Record<string, string> = {
    APPROVED: "approved",
    APPROVAL_COMPLETED: "approved",
    REJECTED: "rejected",
    CANCELED: "canceled",
    IN_PROGRESS: "in_progress",
    PENDING: "pending",
    WAITING: "pending",
  };
  return statusMap[normalized] ?? normalized.toLowerCase();
}
