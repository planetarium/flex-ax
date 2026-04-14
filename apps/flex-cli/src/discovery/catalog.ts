import { readFile } from "node:fs/promises";
import type { ApiCatalog, CatalogEntry } from "../types/catalog.js";
import { normalizeUrlPath, type CapturedRequest } from "./traffic-capture.js";
import type { DiscoveredPage } from "./navigator.js";

/** 알려진 엔드포인트 패턴 → 안정적 ID 매핑 */
const ENDPOINT_PATTERNS: Array<{ id: string; method: string; pattern: RegExp }> = [
  // --- 워크플로우 / 결재 ---
  { id: "template-list", method: "GET", pattern: /\/api\/v\d+\/approval-document-template\/templates$/ },
  { id: "template-detail", method: "GET", pattern: /\/api\/v\d+\/approval-document-template\/templates\/[^/]+$/ },
  { id: "template-options", method: "GET", pattern: /\/api\/v\d+\/approval-document-template\/templates\.options$/ },
  { id: "instance-search", method: "POST", pattern: /\/action\/v\d+\/approval-document\/user-boxes\/search/ },
  { id: "instance-detail", method: "GET", pattern: /\/api\/v\d+\/approval-document\/approval-documents\/[^/]+$/ },
  { id: "instance-options", method: "GET", pattern: /\/api\/v\d+\/approval-document\/approval-documents\.options$/ },
  { id: "instance-search-templates", method: "GET", pattern: /\/api\/v\d+\/approval-document\/search-templates$/ },

  // --- 사용자 / 인사 (core) ---
  { id: "user-me", method: "GET", pattern: /\/api\/v\d+\/core\/me/ },
  { id: "user-me-workspace", method: "GET", pattern: /\/api\/v\d+\/core\/users\/me\/workspace-users/ },
  { id: "user-employee", method: "GET", pattern: /\/api\/v\d+\/core\/user-employees\/[^/]+$/ },
  { id: "user-personal", method: "GET", pattern: /\/api\/v\d+\/core\/user-personals\/[^/]+$/ },
  { id: "user-statuses", method: "GET", pattern: /\/api\/v\d+\/core\/users\/[^/]+\/statuses$/ },
  { id: "user-salary-contracts", method: "GET", pattern: /\/api\/v\d+\/core\/user-salary-contracts\/by-user\/[^/]+$/ },
  { id: "user-approval-info", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/users\/[^/]+\/approval-info$/ },
  { id: "user-personnel-appointments", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/users\/[^/]+\/personnel-appointments$/ },
  { id: "user-rewards-search", method: "POST", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/users\/[^/]+\/user-rewards\/search$/ },
  { id: "user-disciplines-search", method: "POST", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/users\/[^/]+\/user-disciplines\/search$/ },
  { id: "user-resignations", method: "GET", pattern: /\/action\/v\d+\/core\/user-resignations\/by-user\/[^/]+$/ },
  { id: "user-leave-of-absences", method: "GET", pattern: /\/action\/v\d+\/core\/user-leave-of-absences\/by-user\/[^/]+$/ },
  { id: "user-employee-bundle", method: "POST", pattern: /\/action\/v\d+\/core\/bundle\/user-employees\/[^/]+\/get$/ },
  { id: "user-personal-bundle", method: "POST", pattern: /\/action\/v\d+\/core\/bundle\/user-personals\/[^/]+\/get$/ },
  { id: "employment-contracts-search", method: "POST", pattern: /\/action\/v\d+\/core\/bundle\/user-employment-contracts\/search$/ },
  { id: "work-experiences-search", method: "POST", pattern: /\/action\/v\d+\/core\/work-experiences\/search-with-approval$/ },
  { id: "education-experiences-search", method: "POST", pattern: /\/action\/v\d+\/core\/education-experiences\/search-with-approval$/ },
  { id: "dependent-families-search", method: "POST", pattern: /\/action\/v\d+\/core\/dependent-families\/search-with-approval$/ },
  { id: "departments-search", method: "POST", pattern: /\/action\/v\d+\/core\/departments\/search$/ },
  { id: "image-presets-search", method: "POST", pattern: /\/api\/v\d+\/core\/image-presets\/search$/ },
  { id: "customer-info", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/info$/ },
  { id: "customer-job-ranks", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/job-ranks$/ },
  { id: "customer-job-roles", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/job-roles$/ },
  { id: "customer-job-titles", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/job-titles$/ },
  { id: "customer-disciplines", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/disciplines$/ },
  { id: "personnel-appointment-options", method: "GET", pattern: /\/api\/v\d+\/core\/personnel-appointment\.options$/ },
  { id: "customer-birth-dates", method: "GET", pattern: /\/action\/v\d+\/core\/customers\/[^/]+\/user-personals\/birth-dates$/ },

  // --- 휴가 (time-off) ---
  { id: "time-off-uses", method: "GET", pattern: /\/api\/v\d+\/time-off\/users\/[^/]+\/time-off-uses/ },
  { id: "time-off-buckets", method: "GET", pattern: /\/api\/v\d+\/time-off\/users\/[^/]+\/usable-grouped-time-off-buckets/ },
  { id: "time-off-approval-task", method: "GET", pattern: /\/api\/v\d+\/time-off\/users\/[^/]+\/approval-task\// },
  { id: "time-off-policies", method: "GET", pattern: /\/api\/v\d+\/time-off\/customers\/[^/]+\/annual-time-off-policies/ },
  { id: "time-off-forms", method: "GET", pattern: /\/api\/v\d+\/time-off\/customers\/[^/]+\/time-off-forms/ },
  { id: "time-off-policy-detail", method: "GET", pattern: /\/api\/v\d+\/time-off\/customers\/[^/]+\/time-off-policies\// },
  { id: "time-off-user-context", method: "GET", pattern: /\/api\/v\d+\/time-off\/customers\/[^/]+\/users\/[^/]+\/context/ },
  { id: "time-off-promotion", method: "GET", pattern: /\/api\/v\d+\/time-off\/customers\/[^/]+\/annual-time-off-promotion\// },
  { id: "time-off-assigns-options", method: "GET", pattern: /\/api\/v\d+\/time-off\/time-off-assigns\.options$/ },

  // --- 근무 규칙 (work-rule) ---
  { id: "work-rules-user", method: "GET", pattern: /\/api\/v\d+\/work-rule\/users\/[^/]+\/work-rules/ },
  { id: "working-periods", method: "GET", pattern: /\/api\/v\d+\/work-rule\/users\/[^/]+\/working-periods/ },
  { id: "work-plan-auto", method: "GET", pattern: /\/api\/v\d+\/work-rule\/users\/[^/]+\/work-plan\/auto/ },
  { id: "work-rules-customer", method: "GET", pattern: /\/api\/v\d+\/work-rule\/customers\/[^/]+\/work-rules/ },
  { id: "work-forms", method: "GET", pattern: /\/api\/v\d+\/work-rule\/customers\/[^/]+\/work-forms$/ },
  { id: "work-approval-rules", method: "GET", pattern: /\/api\/v\d+\/work-rule\/customers\/[^/]+\/work-approval-rules\// },

  // --- 캘린더 ---
  { id: "calendar-primary", method: "GET", pattern: /\/api\/v\d+\/calendar\/calendars\/primary$/ },
  { id: "calendar-coworkers", method: "GET", pattern: /\/api\/v\d+\/calendar\/calendars\/coworkers$/ },
  { id: "calendar-events", method: "POST", pattern: /\/api\/v\d+\/calendar\/calendars\/events$/ },
  { id: "calendar-recurrence-events", method: "POST", pattern: /\/api\/v\d+\/calendar\/calendars\/recurrence-events$/ },

  // --- 공휴일 (holiday) ---
  // 더 구체적인 sub-resource 패턴을 holiday-groups 보다 위에 두어 우선 매칭되게 한다
  { id: "public-holidays", method: "GET", pattern: /\/api\/v\d+\/holiday\/customers\/[^/]+\/customer-holiday-groups\/[^/]+\/public-holidays$/ },
  { id: "customer-holidays", method: "GET", pattern: /\/api\/v\d+\/holiday\/customers\/[^/]+\/customer-holiday-groups\/[^/]+\/customer-holidays$/ },
  // holiday-groups: 정확히 .../customer-holiday-groups 또는 .../customer-holiday-groups/{id}만 매칭
  { id: "holiday-groups", method: "GET", pattern: /\/api\/v\d+\/holiday\/customers\/[^/]+\/customer-holiday-groups(?:\/[^/]+)?$/ },
  { id: "convert-to-lunar", method: "POST", pattern: /\/action\/v\d+\/holiday\/date\/[^/]+\/convert-to-lunar$/ },

  // --- 검색 (search) ---
  { id: "search-users", method: "GET", pattern: /\/api\/v\d+\/search\/customers\/[^/]+\/time-series\/search-users/ },
  { id: "search-users-post", method: "POST", pattern: /\/action\/v\d+\/search\/customers\/[^/]+\/time-series\/search-users$/ },
  { id: "search-filter-options", method: "GET", pattern: /\/action\/v\d+\/search\/customers\/[^/]+\/filter\.options$/ },
  { id: "search-table-view-permissions", method: "GET", pattern: /\/action\/v\d+\/search\/customers\/[^/]+\/table-view\.permissions$/ },

  // --- 알림 / 피드백 / 할 일 ---
  { id: "notification-unread", method: "GET", pattern: /\/action\/v\d+\/notification\/topics\/count-unread$/ },
  { id: "feedback-chunk", method: "POST", pattern: /\/action\/v\d+\/feedback\/feedbacks\/get-chunk$/ },
  { id: "feedback-count", method: "POST", pattern: /\/action\/v\d+\/feedback\/feedbacks\/get-count$/ },
  { id: "todo-search", method: "POST", pattern: /\/action\/v\d+\/todo\/assigned-todos\/search$/ },
  { id: "stakeholder-users", method: "POST", pattern: /\/action\/v\d+\/stakeholder\/get-stakeholder-users-list$/ },

  // --- 공지 ---
  { id: "notice-posts", method: "GET", pattern: /\/api\/v\d+\/notice\/posts$/ },
  { id: "notice-permissions", method: "GET", pattern: /\/api\/v\d+\/notice\/notices\.permissions$/ },

  // --- 워크스페이스 ---
  { id: "workspace-users", method: "GET", pattern: /\/api\/v\d+\/workspace\/users\/[^/]+\/workspace-customers$/ },
  { id: "workspace-users-me", method: "GET", pattern: /\/api\/v\d+\/workspace\/users\/me\/workspace-users$/ },
  { id: "workspace-corporate-group", method: "GET", pattern: /\/api\/v\d+\/workspace\/customers\/[^/]+\/customer-in-corporate-group$/ },

  // --- 인증 ---
  { id: "auth-methods", method: "GET", pattern: /\/api\/v\d+\/auth\/account\/authentication-methods$/ },
  { id: "auth-access-control", method: "GET", pattern: /\/api\/v\d+\/auth\/account\/access-control-settings$/ },
  { id: "auth-session-timeout", method: "GET", pattern: /\/api\/v\d+\/auth\/customers\/[^/]+\/login-policy\/session-timeout/ },

  // --- 성과 / 목표 / 평가 ---
  { id: "performance-preview", method: "GET", pattern: /\/api\/v\d+\/performance-management\/customers\/[^/]+\/users\/[^/]+\/preview/ },
  { id: "performance-migration", method: "GET", pattern: /\/api\/v\d+\/performance-management\/customers\/[^/]+\/migration-reservations$/ },
  { id: "goal-options", method: "GET", pattern: /\/api\/v\d+\/goal\/options$/ },
  { id: "evaluation-options", method: "GET", pattern: /\/api\/v\d+\/evaluation\/menu\.options$/ },

  // --- 기타 ---
  { id: "billing-status", method: "GET", pattern: /\/api\/v\d+\/billing\/status/ },
  { id: "subscription-features", method: "GET", pattern: /\/api\/v\d+\/subscription\/customers\/[^/]+\/features$/ },
  { id: "onboarding", method: "GET", pattern: /\/api\/v\d+\/onboarding\// },
  { id: "yearend-widget", method: "GET", pattern: /\/api\/v\d+\/yearend\/settlements\/[^/]+\/user-widget$/ },
  { id: "background-tasks", method: "GET", pattern: /\/api\/v\d+\/background-task\/tasks$/ },
  { id: "meeting-options", method: "GET", pattern: /\/api\/v\d+\/meeting\/\.options$/ },
  { id: "growth-surveys", method: "GET", pattern: /\/api\/v\d+\/growth\/registration-surveys$/ },
  { id: "file-restrictions", method: "GET", pattern: /\/api\/v\d+\/file\/restrictions\/source-types$/ },
  { id: "terms-agreements", method: "GET", pattern: /\/api\/v\d+\/terms\/users\/agreements\.options$/ },
  { id: "bulk-changes-permissions", method: "GET", pattern: /\/action\/v\d+\/bulk-changes\/data\.permissions$/ },
  { id: "payroll-permissions", method: "GET", pattern: /\/api\/v\d+\/payroll\/allowance\/user-allowances\.permissions$/ },
  { id: "checklist-permissions", method: "GET", pattern: /\/api\/v\d+\/checklist\// },
  { id: "gnb-menu-types", method: "POST", pattern: /\/remotes\/gnb\/api\/granted-menu-types$/ },
  { id: "user-profile-permissions", method: "POST", pattern: /\/remotes\/user-profile\/api\/permissions$/ },

  // --- 문서·증명서 ---
  { id: "certificate-issuance-policies", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/user-certificate-issuance-policies/ },
  { id: "certificate-issuance-histories", method: "GET", pattern: /\/api\/v\d+\/core\/customers\/[^/]+\/all-user-certificate-issuance-histories/ },
  { id: "customer-attachments-search", method: "POST", pattern: /\/action\/v\d+\/core\/customer-attachments\/search$/ },
  { id: "customer-attachments-permissions", method: "GET", pattern: /\/api\/v\d+\/core\/customer-attachments\.permissions$/ },
  { id: "customer-attachments-bulk-permissions", method: "GET", pattern: /\/action\/v\d+\/core\/customer-attachments\/bulk\.permissions$/ },
  { id: "file-signed-url", method: "GET", pattern: /\/api\/v\d+\/file\/files\/[^/]+\/signed-url$/ },
  { id: "holiday-user-groups", method: "GET", pattern: /\/api\/v\d+\/holiday\/customers\/[^/]+\/users\/[^/]+\/customer-holiday-groups$/ },
];

/**
 * URL을 카탈로그용 안정적 패턴으로 변환한다.
 * traffic-capture의 중복 제거 키와 동일한 정규화 규칙을 쓴다
 * (해시/숫자 ID, 숫자 범위 등). {id}/{range} placeholder를
 * 카탈로그 관례에 맞춰 {param}/{range}로 노출한다.
 */
function generalizeUrlPattern(url: string): string {
  const parsed = new URL(url);
  return normalizeUrlPath(parsed.pathname).replace(/\{id\}/g, "{param}");
}

/** URL에서 쿼리 파라미터 추출 */
function extractQueryParams(url: string): Record<string, string> | undefined {
  const parsed = new URL(url);
  const params: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return Object.keys(params).length > 0 ? params : undefined;
}

/** 캡처된 요청에 ID를 매칭 */
function matchEndpointId(method: string, url: string): string | null {
  const pathname = new URL(url).pathname;
  for (const pattern of ENDPOINT_PATTERNS) {
    if (pattern.method === method && pattern.pattern.test(pathname)) {
      return pattern.id;
    }
  }
  return null;
}

/** 캡처 결과 + 페이지 정보로 카탈로그 생성 */
export function buildCatalog(
  captures: CapturedRequest[],
  discoveredPages: DiscoveredPage[],
  flexBaseUrl: string,
): ApiCatalog {
  const entries: CatalogEntry[] = [];
  const unclassified: CatalogEntry[] = [];

  for (const capture of captures) {
    const id = matchEndpointId(capture.method, capture.url);
    const urlPattern = generalizeUrlPattern(capture.url);
    const pageInfo = discoveredPages.find((p) =>
      capture.pageUrl.includes(p.url),
    );

    const entry: CatalogEntry = {
      id,
      discoveredFrom: new URL(capture.pageUrl).pathname,
      menuLabel: pageInfo?.menuLabel,
      method: capture.method as CatalogEntry["method"],
      urlPattern,
      exampleUrl: new URL(capture.url).pathname + new URL(capture.url).search,
      queryParams: extractQueryParams(capture.url),
      requestBodySample: capture.requestBody,
      statusCode: capture.statusCode,
      responseBodySample: capture.responseBody,
      totalItems: capture.totalItems,
      capturedAt: capture.capturedAt,
    };

    if (id) {
      entries.push(entry);
    } else {
      unclassified.push(entry);
    }
  }

  return {
    version: "1.0",
    capturedAt: new Date().toISOString(),
    flexBaseUrl,
    discoveredPages: discoveredPages.map((p) => p.url),
    entries,
    unclassified,
  };
}

/** 파일에서 카탈로그 로드 */
export async function loadCatalog(catalogPath: string): Promise<ApiCatalog | null> {
  try {
    const content = await readFile(catalogPath, "utf-8");
    return JSON.parse(content) as ApiCatalog;
  } catch {
    return null;
  }
}
