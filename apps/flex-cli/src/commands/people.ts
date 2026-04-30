import { flexFetch, flexPost, withRetry } from "../crawlers/shared.js";
import { withLiveCommandContext } from "./live-common.js";

interface PeopleOpts {
  customer?: string;
  keyword: string;
  department?: string;
  limit: number;
  includeInactive: boolean;
  positional: string[];
}

interface Department {
  idHash: string;
  customerIdHash: string;
  parentDepartmentIdHash?: string;
  name: string;
  visible: boolean;
  displayOrder?: number;
  beginDateTime?: string;
  endDateTime?: string;
}

interface Person {
  customerIdHash: string;
  userIdHash: string;
  basicInfo: {
    name?: string;
    email?: string;
    originEmail?: string;
    displayName?: string;
    profileImageUrl?: string;
    profileThumbnailImageUrl?: string;
    profileImageFileKey?: string;
    profileCoverImageUrl?: string;
    profileCoverImagePresetIdHash?: string;
    nameInEnglishFirst?: string;
    nameInEnglishLast?: string;
    aboutMe?: string;
    phoneNumber?: string;
  };
  privateInfo?: {
    personalEmail?: string;
    phoneNumber?: string;
    phoneNumberCountryCode?: string;
  };
  employeeInfo?: {
    positions?: Array<{
      departmentIdHash?: string;
      departmentName?: string;
      jobTitleIdHash?: string;
      jobTitleName?: string;
      isHeadUser?: boolean;
      isPrimary?: boolean;
      displayOrder?: number;
    }>;
    jobRoles?: Array<{ idHash?: string; name?: string }>;
    jobGroups?: Array<{ idHash?: string; name?: string }>;
    jobRanks?: Array<{ idHash?: string; name?: string }>;
    jobLevels?: Array<{ idHash?: string; name?: string }>;
    departments?: Array<{ idHash?: string; name?: string }>;
    jobTitles?: Array<{ idHash?: string; name?: string }>;
  };
  leaveOfAbsences?: unknown[];
  tagInfo?: {
    userStatuses?: string[];
    contractExpireTypes?: string[];
  };
}

interface SearchUsersResponse {
  hasNext: boolean;
  continuation?: string;
  total?: { relation?: string; value?: number };
  list: Person[];
}

export async function runPeople(argv: string[] = process.argv.slice(3)): Promise<void> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "list":
      await cmdList(rest);
      return;
    case "show":
      await cmdShow(rest);
      return;
    case "departments":
      await cmdDepartments(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      process.exit(sub === undefined ? 1 : 0);
    default:
      console.error(`[FLEX-AX:PEOPLE:ERROR] 알 수 없는 서브커맨드: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: flex-ax people <subcommand>

Subcommands:
  list                          구성원 목록 조회
  show <userIdHash>             특정 구성원 상세 조회
  departments                   부서 목록 조회

Options:
  --customer <customerIdHash>   대상 법인 지정
  --keyword <text>              이름/표시명 검색어
  --department <departmentId>   부서 필터
  --limit <n>                   최대 결과 수 (기본: 50)
  --include-inactive            비활성/퇴사 예정 상태도 포함

Examples:
  flex-ax people list
  flex-ax people list --keyword swen
  flex-ax people list --department V3z2YgYZ0M
  flex-ax people show k1EB1Mlzyq
  flex-ax people departments
`);
}

function parseOpts(args: string[], defaultLimit: number): PeopleOpts {
  const opts: PeopleOpts = {
    keyword: "",
    limit: defaultLimit,
    includeInactive: false,
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--customer") {
      opts.customer = args[++i];
    } else if (arg === "--keyword") {
      opts.keyword = args[++i] ?? "";
    } else if (arg === "--department") {
      opts.department = args[++i];
    } else if (arg === "--limit") {
      const value = Number.parseInt(args[++i] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--limit은 1 이상의 정수여야 합니다.");
      }
      opts.limit = value;
    } else if (arg === "--include-inactive") {
      opts.includeInactive = true;
    } else {
      opts.positional.push(arg);
    }
  }

  return opts;
}

async function cmdList(args: string[]): Promise<void> {
  const opts = parseOpts(args, 50);
  await withLiveCommandContext("PEOPLE", opts, async ({ authCtx, config, corp }) => {
    const people = await searchPeople(authCtx, config.flexBaseUrl, corp.customerIdHash, {
      keyword: opts.keyword,
      departmentId: opts.department,
      limit: opts.limit,
      includeInactive: opts.includeInactive,
      maxRetries: config.maxRetries,
      delayMs: config.requestDelayMs,
    });
    console.log(JSON.stringify(people.map(toPersonSummary), null, 2));
  });
}

async function cmdShow(args: string[]): Promise<void> {
  const opts = parseOpts(args, 50);
  const userIdHash = opts.positional[0];
  if (!userIdHash) {
    console.error("[FLEX-AX:PEOPLE:ERROR] show 대상 userIdHash를 지정하세요.");
    process.exit(1);
  }

  await withLiveCommandContext("PEOPLE", opts, async ({ authCtx, config, corp }) => {
    const person = await fetchPersonDetail(
      authCtx,
      config.flexBaseUrl,
      corp.customerIdHash,
      userIdHash,
      config.maxRetries,
      config.requestDelayMs,
    );
    console.log(JSON.stringify(toPersonDetail(person), null, 2));
  });
}

async function cmdDepartments(args: string[]): Promise<void> {
  const opts = parseOpts(args, 200);
  await withLiveCommandContext("PEOPLE", opts, async ({ authCtx, config, corp }) => {
    const departments = await fetchDepartments(
      authCtx,
      config.flexBaseUrl,
      corp.customerIdHash,
      config.maxRetries,
      config.requestDelayMs,
    );
    console.log(
      JSON.stringify(
        departments.map((department) => ({
          id: department.idHash,
          name: department.name,
          parentId: department.parentDepartmentIdHash ?? null,
          visible: department.visible,
          displayOrder: department.displayOrder ?? null,
        })),
        null,
        2,
      ),
    );
  });
}

async function searchPeople(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  customerIdHash: string,
  opts: {
    keyword: string;
    departmentId?: string;
    limit: number;
    includeInactive: boolean;
    maxRetries: number;
    delayMs: number;
  },
): Promise<Person[]> {
  const results: Person[] = [];
  let continuation: string | undefined;
  let hasNext = true;

  while (hasNext && results.length < opts.limit) {
    const params = new URLSearchParams({
      size: String(Math.min(opts.limit, 50)),
    });
    if (continuation) {
      params.set("continuation", continuation);
    }

    const page = await withRetry(
      () =>
        flexPost<SearchUsersResponse>(
          authCtx,
          `${baseUrl}/action/v2/search/customers/${customerIdHash}/time-series/search-users?${params.toString()}`,
          {
            sort: { sortType: "DISPLAY_NAME", directionType: "ASC" },
            filter: {
              jobTitleIdHashes: [],
              jobRankIdHashes: [],
              jobRoleIdHashes: [],
              departmentIdHashes: opts.departmentId ? [opts.departmentId] : [],
              userStatuses: opts.includeInactive
                ? [
                    "LEAVE_OF_ABSENCE",
                    "LEAVE_OF_ABSENCE_SCHEDULED",
                    "RESIGNATION_SCHEDULED",
                    "IN_EMPLOY",
                    "IN_APPRENTICESHIP",
                  ]
                : ["IN_EMPLOY", "IN_APPRENTICESHIP"],
              jobGroupIdHashes: [],
              headUsers: [],
            },
            keyword: opts.keyword,
          },
        ),
      { maxRetries: opts.maxRetries, delayMs: opts.delayMs },
    );

    results.push(...page.list);
    if (!page.hasNext || results.length >= opts.limit) {
      hasNext = false;
      continue;
    }
    if (!page.continuation || page.continuation === continuation) {
      hasNext = false;
      continue;
    }
    continuation = page.continuation;
  }

  return results.slice(0, opts.limit);
}

async function fetchPersonDetail(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  customerIdHash: string,
  userIdHash: string,
  maxRetries: number,
  delayMs: number,
): Promise<Person> {
  const data = await withRetry(
    () =>
      flexFetch<Person[]>(
        authCtx,
        `${baseUrl}/api/v2/search/customers/${customerIdHash}/time-series/search-users/${userIdHash}`,
      ),
    { maxRetries, delayMs },
  );
  const person = data[0];
  if (!person) {
    throw new Error(`구성원을 찾을 수 없습니다: ${userIdHash}`);
  }
  return person;
}

async function fetchDepartments(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  customerIdHash: string,
  maxRetries: number,
  delayMs: number,
): Promise<Department[]> {
  return withRetry(
    () =>
      flexPost<Department[]>(
        authCtx,
        `${baseUrl}/action/v2/core/departments/search`,
        { customerIdHashes: [customerIdHash] },
      ),
    { maxRetries, delayMs },
  );
}

function toPersonSummary(person: Person): Record<string, unknown> {
  return {
    userIdHash: person.userIdHash,
    name: person.basicInfo.name ?? null,
    displayName: person.basicInfo.displayName ?? null,
    email: person.basicInfo.email ?? null,
    departments: (person.employeeInfo?.departments ?? []).map((department) => department.name).filter(Boolean),
    jobTitles: (person.employeeInfo?.jobTitles ?? []).map((title) => title.name).filter(Boolean),
    jobRanks: (person.employeeInfo?.jobRanks ?? []).map((rank) => rank.name).filter(Boolean),
    userStatuses: person.tagInfo?.userStatuses ?? [],
  };
}

function toPersonDetail(person: Person): Record<string, unknown> {
  return {
    userIdHash: person.userIdHash,
    customerIdHash: person.customerIdHash,
    basicInfo: person.basicInfo,
    privateInfo: person.privateInfo ?? null,
    positions: person.employeeInfo?.positions ?? [],
    departments: person.employeeInfo?.departments ?? [],
    jobTitles: person.employeeInfo?.jobTitles ?? [],
    jobRoles: person.employeeInfo?.jobRoles ?? [],
    jobRanks: person.employeeInfo?.jobRanks ?? [],
    jobGroups: person.employeeInfo?.jobGroups ?? [],
    jobLevels: person.employeeInfo?.jobLevels ?? [],
    leaveOfAbsences: person.leaveOfAbsences ?? [],
    tagInfo: person.tagInfo ?? null,
    raw: person,
  };
}
