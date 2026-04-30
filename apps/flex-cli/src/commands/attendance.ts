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

interface WorkSchedulesResponse {
  userIdHash: string;
  dailySchedules?: WorkDailySchedule[];
}

interface WorkDailySchedule {
  date: string;
  timezone?: string;
  dayOffs?: unknown[];
  timeBlocks?: unknown[];
  legalTimeBlocks?: unknown[];
  approvals?: unknown[];
}

interface WorkClockResponse {
  records?: unknown[];
}

interface WorkingPeriodsResponse {
  periods?: unknown[];
}

interface TimeOffBalancesResponse {
  groupedBucketsItems?: TimeOffGroupedBucket[];
  annualTimeOffPolicy?: unknown;
  customerTimeOffForms?: unknown[];
}

interface TimeOffGroupedBucket {
  buckets?: TimeOffBucket[];
  totalRemainingTimeOffTimes?: unknown;
  totalRemainingTimeOffTime?: unknown;
  totalUsableTimeOffTimes?: unknown;
  totalUsableTimeOffTime?: unknown;
  timeOffGroupedBucketMetaDataDto?: {
    timeOffPolicyId?: string;
    timeOffPolicyType?: string;
    displayName?: string;
    name?: string;
    displayInfo?: {
      name?: string;
      description?: string;
      emoji?: unknown;
      icon?: unknown;
    };
  };
}

interface TimeOffBucket {
  timeOffPolicyId?: string;
  timeOffPolicyType?: string;
  assignedAt?: string;
  validUsageFrom?: string;
  validUsageTo?: string;
  expirationDate?: string;
  assignedTime?: number;
  usedTime?: number;
  remainingTime?: unknown;
  remainingAmount?: unknown;
  assignMethod?: string;
  minimumUsageLimit?: string;
  usageGenderLimit?: string;
  certificateSubmissionLimit?: string;
  holidayUsageCounted?: boolean;
}

interface TimeOffFormsResponse {
  timeOffForms?: Array<{
    customerTimeOffForm?: TimeOffForm;
    updatable?: boolean;
  }>;
}

interface TimeOffForm {
  customerIdHash?: string;
  timeOffPolicyId?: string;
  timeOffPolicyType?: string;
  category?: string;
  legalMandatory?: boolean;
  active?: boolean;
  paid?: unknown;
  displayInfo?: {
    name?: string;
    description?: string;
    displayOrder?: number;
    emoji?: unknown;
    icon?: unknown;
  };
  approval?: {
    enabled?: boolean;
    templateKey?: string;
    cancelEnabled?: boolean;
    cancelTemplateKey?: string;
  };
  assignMethod?: string;
  minimumUsageMinutes?: number;
  certificateDescription?: string;
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
    case "work-records":
      await cmdWorkRecords(rest);
      return;
    case "balances":
      await cmdBalances(rest);
      return;
    case "policies":
      await cmdPolicies(rest);
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
  work-records                  내 근무 일정/기록 조회
  balances                      사용 가능한 휴가 잔여량 조회
  policies                      휴가 정책/유형 목록 조회

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
  flex-ax attendance work-records --from 2026-04-01 --to 2026-04-30
  flex-ax attendance balances
  flex-ax attendance policies
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

async function cmdWorkRecords(args: string[]): Promise<void> {
  const opts = parseOpts(args, 100);
  await withLiveCommandContext("ATTENDANCE", opts, async ({ authCtx, config }) => {
    const userId = await getCurrentUserId(authCtx, config.flexBaseUrl, config.maxRetries, config.requestDelayMs);
    const range = resolveDateRange(opts.from, opts.to, "month");
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";

    const [schedules, workClock, workingPeriods] = await Promise.all([
      fetchWorkSchedules(authCtx, config.flexBaseUrl, userId, range, timezone, config.maxRetries, config.requestDelayMs),
      fetchWorkClockRecords(authCtx, config.flexBaseUrl, userId, range, config.maxRetries, config.requestDelayMs),
      fetchWorkingPeriods(authCtx, config.flexBaseUrl, userId, range, config.maxRetries, config.requestDelayMs),
    ]);

    console.log(
      JSON.stringify(
        {
          userIdHash: userId,
          from: range.from,
          to: range.to,
          timezone,
          dailySchedules: (schedules.dailySchedules ?? []).map(toWorkScheduleSummary),
          workClockRecords: workClock.records ?? [],
          workingPeriods: workingPeriods.periods ?? [],
        },
        null,
        2,
      ),
    );
  });
}

async function cmdBalances(args: string[]): Promise<void> {
  const opts = parseOpts(args, 100);
  await withLiveCommandContext("ATTENDANCE", opts, async ({ authCtx, config }) => {
    const userId = await getCurrentUserId(authCtx, config.flexBaseUrl, config.maxRetries, config.requestDelayMs);
    const timestamp = opts.to ? toEpochMs(opts.to, false) : Date.now();
    const balances = await fetchTimeOffBalances(
      authCtx,
      config.flexBaseUrl,
      userId,
      timestamp,
      config.maxRetries,
      config.requestDelayMs,
    );
    console.log(
      JSON.stringify(
        {
          userIdHash: userId,
          timestamp,
          asOf: new Date(timestamp).toISOString(),
          balances: (balances.groupedBucketsItems ?? []).map(toTimeOffBalanceSummary),
          annualTimeOffPolicy: balances.annualTimeOffPolicy ?? null,
        },
        null,
        2,
      ),
    );
  });
}

async function cmdPolicies(args: string[]): Promise<void> {
  const opts = parseOpts(args, 100);
  await withLiveCommandContext("ATTENDANCE", opts, async ({ authCtx, config, corp }) => {
    const policies = await fetchTimeOffPolicies(
      authCtx,
      config.flexBaseUrl,
      corp.customerIdHash,
      config.maxRetries,
      config.requestDelayMs,
    );
    const normalizedType = opts.type?.trim().toUpperCase();
    const rows = (policies.timeOffForms ?? [])
      .map((entry) => entry.customerTimeOffForm)
      .filter((form): form is TimeOffForm => Boolean(form))
      .filter((form) => !normalizedType || form.timeOffPolicyType?.toUpperCase() === normalizedType)
      .slice(0, opts.limit)
      .map(toTimeOffPolicySummary);
    console.log(JSON.stringify(rows, null, 2));
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

async function fetchWorkSchedules(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  userId: string,
  range: DateRange,
  timezone: string,
  maxRetries: number,
  delayMs: number,
): Promise<WorkSchedulesResponse> {
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    timezone,
  });
  return withRetry(
    () =>
      flexFetch<WorkSchedulesResponse>(
        authCtx,
        `${baseUrl}/api/v3/time-tracking/users/${userId}/work-schedules?${params.toString()}`,
      ),
    { maxRetries, delayMs },
  );
}

async function fetchWorkClockRecords(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  userId: string,
  range: DateRange,
  maxRetries: number,
  delayMs: number,
): Promise<WorkClockResponse> {
  const params = new URLSearchParams({
    userIdHashes: userId,
    timeStampFrom: String(toEpochMs(range.from, true)),
    timeStampTo: String(toEpochMs(range.to, false)),
  });
  return withRetry(
    () => flexFetch<WorkClockResponse>(authCtx, `${baseUrl}/api/v2/time-tracking/work-clock/users?${params.toString()}`),
    { maxRetries, delayMs },
  );
}

async function fetchWorkingPeriods(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  userId: string,
  range: DateRange,
  maxRetries: number,
  delayMs: number,
): Promise<WorkingPeriodsResponse> {
  return withRetry(
    () =>
      flexFetch<WorkingPeriodsResponse>(
        authCtx,
        `${baseUrl}/api/v2/work-rule/users/${userId}/working-periods/by-timestamp-range/${toEpochMs(
          range.from,
          true,
        )}..${toEpochMs(range.to, false)}`,
      ),
    { maxRetries, delayMs },
  );
}

async function fetchTimeOffBalances(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  userId: string,
  timestamp: number,
  maxRetries: number,
  delayMs: number,
): Promise<TimeOffBalancesResponse> {
  return withRetry(
    () =>
      flexFetch<TimeOffBalancesResponse>(
        authCtx,
        `${baseUrl}/api/v2/time-off/users/${userId}/usable-grouped-time-off-buckets/by-time-stamp/${timestamp}`,
      ),
    { maxRetries, delayMs },
  );
}

async function fetchTimeOffPolicies(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  customerIdHash: string,
  maxRetries: number,
  delayMs: number,
): Promise<TimeOffFormsResponse> {
  return withRetry(
    () =>
      flexFetch<TimeOffFormsResponse>(
        authCtx,
        `${baseUrl}/api/v2/time-off/customers/${customerIdHash}/time-off-forms?includeInactivatedTimeOffForms=true`,
      ),
    { maxRetries, delayMs },
  );
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

function toWorkScheduleSummary(schedule: WorkDailySchedule): Record<string, unknown> {
  return {
    date: schedule.date,
    timezone: schedule.timezone ?? null,
    timeBlocks: schedule.timeBlocks ?? [],
    legalTimeBlocks: schedule.legalTimeBlocks ?? [],
    dayOffs: schedule.dayOffs ?? [],
    approvals: schedule.approvals ?? [],
  };
}

function toTimeOffBalanceSummary(item: TimeOffGroupedBucket): Record<string, unknown> {
  const meta = item.timeOffGroupedBucketMetaDataDto;
  const firstBucket = item.buckets?.[0];
  return {
    policyId: meta?.timeOffPolicyId ?? firstBucket?.timeOffPolicyId ?? null,
    type: meta?.timeOffPolicyType ?? firstBucket?.timeOffPolicyType ?? null,
    name: meta?.displayInfo?.name ?? meta?.displayName ?? meta?.name ?? null,
    remaining: item.totalRemainingTimeOffTime ?? item.totalRemainingTimeOffTimes ?? null,
    usable: item.totalUsableTimeOffTime ?? item.totalUsableTimeOffTimes ?? null,
    buckets: (item.buckets ?? []).map(toTimeOffBucketSummary),
  };
}

function toTimeOffBucketSummary(bucket: TimeOffBucket): Record<string, unknown> {
  return {
    policyId: bucket.timeOffPolicyId ?? null,
    type: bucket.timeOffPolicyType ?? null,
    assignedAt: bucket.assignedAt ?? null,
    validUsageFrom: bucket.validUsageFrom ?? null,
    validUsageTo: bucket.validUsageTo ?? null,
    expirationDate: bucket.expirationDate ?? null,
    assignedTime: bucket.assignedTime ?? null,
    usedTime: bucket.usedTime ?? null,
    remaining: bucket.remainingTime ?? bucket.remainingAmount ?? null,
    assignMethod: bucket.assignMethod ?? null,
    minimumUsageLimit: bucket.minimumUsageLimit ?? null,
    usageGenderLimit: bucket.usageGenderLimit ?? null,
    certificateSubmissionLimit: bucket.certificateSubmissionLimit ?? null,
    holidayUsageCounted: bucket.holidayUsageCounted ?? false,
  };
}

function toTimeOffPolicySummary(form: TimeOffForm): Record<string, unknown> {
  return {
    policyId: form.timeOffPolicyId ?? null,
    type: form.timeOffPolicyType ?? null,
    name: form.displayInfo?.name ?? null,
    description: form.displayInfo?.description ?? null,
    category: form.category ?? null,
    active: form.active ?? null,
    paid: form.paid ?? null,
    legalMandatory: form.legalMandatory ?? false,
    approval: form.approval ?? null,
    assignMethod: form.assignMethod ?? null,
    minimumUsageMinutes: form.minimumUsageMinutes ?? null,
    certificateDescription: form.certificateDescription ?? null,
  };
}

function buildTimeOffUsesUrl(baseUrl: string, continuationToken?: string, nextCursor?: string): string {
  const url = new URL(baseUrl);
  if (continuationToken) url.searchParams.set("continuationToken", continuationToken);
  if (nextCursor) url.searchParams.set("nextCursor", nextCursor);
  return url.toString();
}

interface DateRange {
  from: string;
  to: string;
}

function resolveDateRange(from: string | undefined, to: string | undefined, defaultRange: "year" | "month"): DateRange {
  if (from && to) {
    return { from, to };
  }

  const now = new Date();
  const defaultFrom = new Date(now);
  if (defaultRange === "year") {
    defaultFrom.setFullYear(now.getFullYear() - 1);
  } else {
    defaultFrom.setDate(1);
  }

  return {
    from: from ?? toDateString(defaultFrom),
    to: to ?? toDateString(now),
  };
}

function toDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
