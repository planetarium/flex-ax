import { createHash } from "node:crypto";
import { type AuthContext, apiHeaders } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type {
  StorageWriter,
  WatermarkDomainState,
  WatermarkGroupState,
} from "../storage/index.js";
import type { ApiCatalog } from "../types/catalog.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { ApprovalStep, AttachmentInfo, FieldValue } from "../types/common.js";
import {
  type CrawlResult,
  emptyCrawlResult,
  FlexHttpError,
  nowISO,
  isLaterIso,
  toKstDate,
  withRetry,
  flexFetch,
  flexPost,
  resolveUrl,
  pooledMap,
} from "./shared.js";

export type CrawlMode = "incremental" | "full";

const APPROVAL_DOCUMENTS_DOMAIN = "approvalDocuments";
const MS_PER_DAY = 86_400_000;

/**
 * 결재 문서 검색 스코프.
 *  - "customer": `/customer-boxes/search` — 워크스페이스 전체. 관리자 권한 필요.
 *  - "user":     `/user-boxes/search`     — 로그인 계정이 작성자/결재자/참조자로
 *                                          포함된 문서만 (작성함/결재함/참조함/즐겨찾기).
 * 디폴트는 "customer"로 시도하고 403이 떨어지면 "user"로 폴백한다.
 * planetarium/reflex#49 참조 — 비-customer 스코프에서 큰 워크스페이스는
 * 워크스페이스 모집단의 ~30% 수준만 보인다.
 */
export type BoxScope = "customer" | "user";

const CUSTOMER_BOXES_SEARCH_PATH = "/action/v3/approval-document/customer-boxes/search";
const USER_BOXES_SEARCH_PATH = "/action/v3/approval-document/user-boxes/search";

interface DateRange {
  from: string;
  to: string;
}

export async function crawlInstances(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  storage: StorageWriter,
  logger: Logger,
  mode: CrawlMode = "incremental",
): Promise<
  CrawlResult & {
    collectedKeys: Set<string>;
    missingKeys: string[];
    closedSweepCount: number;
    boxScope: BoxScope;
  }
> {
  const startTime = Date.now();
  const result = emptyCrawlResult();
  const collectedKeys = new Set<string>();
  // full recon이 아닐 땐 의미가 없으므로 비워둔다 (incremental은 변경된
  // 문서만 재방문하니 disk-vs-collected diff는 거짓양성 폭증).
  let missingKeys: string[] = [];
  // 종결 문서 closed-window sweep에서 재조회한 건 수 (informational).
  let closedSweepCount = 0;

  logger.info("인스턴스(결재 문서) 수집 시작", { mode });

  // 스코프 결정은 list-stage try 안에서 수행한다 (아래 참조). 여기서는 catch
  // 경로에서도 의미를 갖는 안전한 디폴트만 박아둔다 — list-stage가 throw해도
  // 반환 객체의 boxScope는 undefined가 아니라 "customer"가 되어 운영자가
  // "스코프 결정 전에 죽음"을 한눈에 식별할 수 있다 (errors에 스코프 probe
  // 실패가 함께 기록되므로 모집단이 좁아진 fallback 케이스와 헷갈리지 않는다).
  let boxScope: BoxScope = "customer";
  let searchUrl = `${config.flexBaseUrl}${CUSTOMER_BOXES_SEARCH_PATH}`;
  const detailBase = resolveUrl(
    config.flexBaseUrl, catalog, "instance-detail",
    "/api/v3/approval-document/approval-documents",
  );

  // 결재 문서 댓글 mutation은 `document.updatedAt`을 갱신하지 않는다
  // (planetarium/reflex#38 검증). 그래서 워터마크 검색만으로는 IN_PROGRESS
  // 동안의 댓글 변화를 잡을 수 없다. IN_PROGRESS는 모집단이 작고 어차피 곧
  // 상태 전이될 가능성이 높아 매 실행 전수 sweep이 안전하고 저렴하다.
  // → incrementalEligible=false: dateRange 안 박고 그룹 워터마크도 안 만듦.
  const searchGroups: SearchGroup[] = [
    {
      label: "in-progress",
      statuses: ["IN_PROGRESS"],
      defaultOverlapDays: 1,
      incrementalEligible: false,
    },
    {
      label: "done",
      statuses: ["DONE", "DECLINED", "CANCELED"],
      defaultOverlapDays: 2,
      incrementalEligible: true,
    },
  ];

  const watermarks = await storage.loadWatermarks();
  const domainState: WatermarkDomainState =
    watermarks[APPROVAL_DOCUMENTS_DOMAIN] ?? { groups: {} };
  // to 날짜는 그룹 진입 전에 한 번 캡처해서 페이지/그룹 간 일관되게 사용.
  const todayKst = toKstDate(new Date());

  // effectiveFull / existingBeforeRun은 검색 스코프(`boxScope`) 결정 후에야
  // 확정할 수 있다 (스코프 변경 시 자동 풀크롤 트리거 때문). 따라서 try 안에서
  // 결정하고, 외부에서는 fallback 의미의 디폴트만 잡아둔다.
  //   - effectiveFull: scope probe가 throw해서 try에 진입하기 전에 catch로
  //     떨어진 경우, "정상 진행 못함"이므로 false로 둔다. listStageOk=false도
  //     함께 잡혀 lastFullReconAt이 갱신되지 않는다.
  //   - existingBeforeRun: null이면 missing diff 자체를 생략 — 부분 결과에서
  //     missing 후보를 만들면 false positive 폭증.
  let effectiveFull = mode === "full";
  let existingBeforeRun: Set<string> | null = null;

  // list-stage(검색 단계)가 try 끝까지 도달했는지 추적. crawlSearchGroup이
  // 재시도 후에도 throw하면 catch에서 false로 전환. failureCount는 doc 단위
  // 실패만 세므로 list 자체가 깨진 케이스를 별도로 표시해둬야 한다.
  let listStageOk = true;

  try {
    // 검색 스코프 probe — customer-boxes(워크스페이스 전체)를 우선 시도하고
    // 403(관리자 권한 부재)이면 user-boxes로 폴백. 폴백은 silent하지 않게
    // warn 로그 + result.errors push로 운영자에게 노출한다. 403 외 에러
    // (네트워크/5xx 등)는 그대로 throw → 아래 catch가 listStageOk=false로
    // 떨어뜨려 워터마크/lastFullReconAt 갱신을 보류한다.
    const resolved = await resolveBoxScope(authCtx, config, catalog, logger, result);
    boxScope = resolved.scope;
    searchUrl = resolved.url;

    // incremental-eligible 그룹들에 워터마크가 모두 비어 있다면 부트스트랩 —
    // 사실상 풀크롤. 비-eligible 그룹(IN_PROGRESS sweep)은 어차피 매 실행
    // 전수 fetch라 effectiveFull 판정에서 제외한다.
    const noWatermarks = searchGroups
      .filter((g) => g.incrementalEligible)
      .every((g) => !domainState.groups[g.label]?.lastUpdatedAt);
    // 스코프가 직전 성공 run과 다르면(또는 처음 보는 필드면) 이번 사이클을
    // 풀크롤로 강제. 핵심 케이스: user-boxes 시절 워터마크가 있는 환경이
    // customer-boxes로 업그레이드된 직후, 운영자가 `--mode=full`을 명시적으로
    // 주지 않아도 자동으로 백필이 일어난다 (planetarium/reflex#49 후속).
    // 이미 부트스트랩이거나 풀모드면 굳이 mismatch 로그를 띄우지 않는다.
    const scopeMismatch =
      !noWatermarks && domainState.lastCrawledBoxScope !== boxScope;
    if (mode === "full") {
      // 명시적 풀모드 — effectiveFull은 이미 true로 초기화됨, 추가 로그 없음.
    } else if (noWatermarks) {
      effectiveFull = true;
      logger.info("워터마크 없음 — bootstrap 풀크롤로 진행");
    } else if (scopeMismatch) {
      effectiveFull = true;
      logger.info("결재 문서 검색 스코프 변경 감지 — 이번 사이클은 풀크롤로 진행", {
        previousScope: domainState.lastCrawledBoxScope ?? null,
        currentScope: boxScope,
      });
    }

    // full reconciliation diff: effectiveFull일 때만 시작 시점의 디스크 상
    // docKey 집합을 캡처해두고, 종료 후 collectedKeys와 차집합을 missing
    // 후보로 보고서에 노출. 자동 tombstone은 별도 트랙.
    if (effectiveFull) {
      try {
        existingBeforeRun = await storage.listExistingInstanceKeys();
        logger.info("full recon — 기존 docKey 스냅샷 캡처", {
          count: existingBeforeRun.size,
        });
      } catch (err) {
        // 스냅샷 실패는 missing diff만 비우고 크롤은 계속 진행 (비치명적).
        logger.error("기존 docKey 스냅샷 실패 — missing diff 생략", {
          error: err instanceof Error ? err.message : String(err),
        });
        result.errors.push({
          target: "instance-recon",
          phase: "list-existing",
          message: err instanceof Error ? err.message : String(err),
          timestamp: nowISO(),
        });
      }
    }

    for (const group of searchGroups) {
      const existing = domainState.groups[group.label];
      // incrementalEligible=false 그룹은 워터마크/풀모드 무관 항상 전수 sweep.
      const dateRange =
        !group.incrementalEligible || effectiveFull
          ? undefined
          : computeDateRange(existing, group.defaultOverlapDays, todayKst);

      const groupSuccessBefore = result.successCount;
      const groupFailureBefore = result.failureCount;

      const observedMaxUpdatedAt = await crawlSearchGroup(
        authCtx,
        config,
        storage,
        logger,
        result,
        collectedKeys,
        searchUrl,
        detailBase,
        group,
        dateRange,
      );

      const groupSuccess = result.successCount - groupSuccessBefore;
      const groupFailure = result.failureCount - groupFailureBefore;

      // 그룹 단위로 워터마크 갱신 정책:
      //   - incrementalEligible=false 그룹은 워터마크 자체를 만들지/갱신하지 않음.
      //     IN_PROGRESS sweep은 댓글 변화 흡수가 목적이라 워터마크가 무의미하고,
      //     watermark.json에 entry를 남기면 다음 실행의 effectiveFull 판정도
      //     흐려진다.
      //   - 그룹 내 실패가 단 1건이라도 있으면 갱신 보류 (다음 실행에서 재시도)
      //   - 후퇴 금지 — 새 max가 기존보다 작으면 기존 lastUpdatedAt 유지
      //   - 0건 처리됐어도 그룹 자체가 클린하게 끝났으면 lastSuccessfulRunAt은 갱신
      if (group.incrementalEligible && groupFailure === 0) {
        const prev = existing?.lastUpdatedAt ?? null;
        if (observedMaxUpdatedAt && isLaterIso(observedMaxUpdatedAt, prev)) {
          domainState.groups[group.label] = {
            lastUpdatedAt: observedMaxUpdatedAt,
            overlapDays: existing?.overlapDays ?? group.defaultOverlapDays,
            lastSuccessfulRunAt: nowISO(),
          };
        } else if (existing) {
          // 0건이거나 후퇴 케이스 — lastUpdatedAt은 보존, 성공 마감 시각만 갱신
          domainState.groups[group.label] = {
            ...existing,
            lastSuccessfulRunAt: nowISO(),
          };
        }
        // existing도 없고 observed도 없으면 commit할 게 없음 (no-op)
      }

      logger.info("인스턴스 그룹 종료", {
        group: group.label,
        groupSuccess,
        groupFailure,
        observedMaxUpdatedAt,
        committedWatermark: domainState.groups[group.label]?.lastUpdatedAt ?? null,
      });
    }
  } catch (error) {
    listStageOk = false;
    logger.error("인스턴스 목록 수집 중 치명적 오류", {
      error: error instanceof Error ? error.message : String(error),
    });
    result.errors.push({
      target: "instance-list",
      phase: "list",
      message: error instanceof Error ? error.message : String(error),
      timestamp: nowISO(),
    });
  }

  // 종결 후 N일 윈도우 sweep — 댓글 mutation은 `document.updatedAt`을 갱신
  // 하지 않아 워터마크 검색이 종결 후의 댓글 변화를 흡수할 수 없다. list 단계가
  // 정상 종료된 경우에만 진행 (list가 깨지면 어차피 신뢰할 수 없는 cycle).
  if (listStageOk && config.closedSweepDays > 0) {
    closedSweepCount = await sweepRecentlyClosed(
      authCtx,
      config,
      storage,
      logger,
      detailBase,
      collectedKeys,
      result,
    );
  }

  // 사실상 풀크롤로 돌았고 list 단계가 끝까지 살아남았으며 인스턴스 단계에
  // 단 1건의 실패도 없었을 때만 lastFullReconAt 갱신. 실패/list-throw가 섞이면
  // "전체 recon 완료" 의미가 흐려지므로, 후속 cadence-기반 자동 풀크롤
  // 트리거가 사고로 다음 실행을 건너뛰지 않도록 보수적으로 잠근다. 정당한
  // 0건(워크스페이스에 문서 없음, 권한 없음 등)도 클린한 recon이므로 stamp
  // 대상이다 — successCount는 게이트하지 않는다.
  if (effectiveFull && listStageOk && result.failureCount === 0) {
    domainState.lastFullReconAt = nowISO();
  }

  // 직전 성공 run의 스코프를 기록한다. listStageOk && failureCount===0 일 때만
  // 박는다 — 부분 실패 cycle에서 갱신하면 다음 run이 "스코프 일치"로 오판해
  // 자동 풀크롤 트리거를 놓칠 수 있다 (자가복구 경로가 막힘). effectiveFull은
  // 게이트하지 않는다 — incremental 사이클에서도 "여전히 같은 스코프"라는
  // 사실은 확정할 가치가 있다.
  if (listStageOk && result.failureCount === 0) {
    domainState.lastCrawledBoxScope = boxScope;
  }

  // Full recon diff — 디스크에 있었지만 이번 실행 목록에서 사라진 docKey들.
  // 권한 회수, 삭제, flex 측 list 누락 등의 신호. 자동 tombstone은 후속.
  // 단, 같은 그룹에 실패가 한 건이라도 있거나 list 단계가 throw로 조기
  // 종료됐다면 collectedKeys가 부분 결과라 missing 판정을 보류한다
  // (false positive 방지).
  if (existingBeforeRun && listStageOk && result.failureCount === 0) {
    const missing: string[] = [];
    for (const key of existingBeforeRun) {
      if (!collectedKeys.has(key)) missing.push(key);
    }
    missing.sort();
    missingKeys = missing;
    if (missing.length > 0) {
      logger.warn("full recon: 목록에서 사라진 docKey 후보", {
        count: missing.length,
        sample: missing.slice(0, 10),
      });
    }
  }

  watermarks[APPROVAL_DOCUMENTS_DOMAIN] = domainState;
  try {
    await storage.saveWatermarks(watermarks);
  } catch (saveError) {
    const message = saveError instanceof Error ? saveError.message : String(saveError);
    logger.error("워터마크 저장 실패 — 다음 실행에서 동일 범위 재수집 가능", { error: message });
    // 보고서/exit code만 보는 환경에서도 운영자가 알아챌 수 있도록 구조화된
    // 에러로 남긴다 (크롤은 비치명적으로 계속 진행).
    result.errors.push({
      target: "instance-watermark",
      phase: "save-watermark",
      message,
      timestamp: nowISO(),
    });
  }

  result.durationMs = Date.now() - startTime;
  logger.info(`\n인스턴스 수집 완료: 성공 ${result.successCount}, 실패 ${result.failureCount}`);
  return { ...result, collectedKeys, missingKeys, closedSweepCount, boxScope };
}

/**
 * 검색 스코프(customer vs user)를 한 번의 size=1 probe로 결정한다.
 * customer-boxes는 관리자 권한이 있어야 200을 받고, 권한 없으면 403이 떨어진다.
 * 비관리자 계정에서도 크롤이 멈추지 않도록 user-boxes로 폴백하되, 운영자가
 * 알 수 있게 warn + result.errors에 기록 — silent하게 모집단이 줄어드는 것
 * 방지가 목적이다(planetarium/reflex#49 참조).
 *
 * 403 외의 에러는 라우팅·서비스 장애일 수 있으므로 그대로 throw하여 호출자
 * 레벨의 list-stage catch가 처리하게 한다 (이때 listStageOk=false로 떨어져
 * watermark/lastFullReconAt 갱신이 보류된다).
 */
async function resolveBoxScope(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  logger: Logger,
  result: CrawlResult,
): Promise<{ scope: BoxScope; url: string }> {
  // user-boxes는 기존 크롤러가 쓰던 경로라 카탈로그에 `instance-search` 엔트리가
  // 이미 박혀 있을 수 있다(버전·테넌트별 분기를 카탈로그가 흡수). 폴백 경로에서도
  // 그 override를 존중하기 위해 resolveUrl로 푼다.
  // customer-boxes는 신규 도입 path이고 카탈로그 발견 대상이 아니므로(`instance-search`
  // 가 user-boxes에 묶여 있기 때문에) 하드코드 유지 — catalog override를 적용하면
  // 잘못된 URL에 customer-scope query를 쏘게 된다.
  const customerUrl = `${config.flexBaseUrl}${CUSTOMER_BOXES_SEARCH_PATH}`;
  const userUrl = resolveUrl(
    config.flexBaseUrl, catalog, "instance-search", USER_BOXES_SEARCH_PATH,
  );
  const probeBody = {
    filter: {
      statuses: ["DONE"],
      templateKeys: [],
      writerHashedIds: [],
      approverTargets: [],
      referrerTargets: [],
      starred: false,
    },
    search: { keyword: "", type: "ALL" },
  };
  const probeUrl = `${customerUrl}?size=1&sortType=LAST_UPDATED_AT&direction=DESC`;
  try {
    // 그룹 search와 동일한 회복력을 갖도록 withRetry로 감싼다 — 그렇지 않으면
    // 일시적 429/5xx/네트워크 블립이 list-stage 전체를 죽인다. 단 403은
    // "권한 없음 = user-boxes로 폴백"의 신호로 사용하므로 재시도 대상에서
    // 제외 — `shouldRetry`로 4xx 전부를 차단해 4xx류는 단발 throw로 끝낸다.
    await withRetry(() => flexPost(authCtx, probeUrl, probeBody), {
      maxRetries: config.maxRetries,
      delayMs: config.requestDelayMs,
      shouldRetry: (e) => !(e instanceof FlexHttpError && e.status >= 400 && e.status < 500),
      onRetry: () => result.retries++,
    });
    logger.info("결재 문서 검색 스코프: customer (워크스페이스 전체)");
    return { scope: "customer", url: customerUrl };
  } catch (err) {
    if (err instanceof FlexHttpError && err.status === 403) {
      logger.warn(
        "customer-boxes/search 403 — user-boxes로 폴백. 워크스페이스 전체가 아닌 " +
          "로그인 계정이 관여한 문서만 수집됩니다. 전체 모집단을 보려면 크롤러 계정에 " +
          "관리자 권한을 부여하세요. (planetarium/reflex#49)",
      );
      result.errors.push({
        target: "instance-scope",
        phase: "scope-detect",
        message: "customer-boxes 403, fallback to user-boxes (narrower scope)",
        timestamp: nowISO(),
      });
      return { scope: "user", url: userUrl };
    }
    throw err;
  }
}

interface SearchGroup {
  label: string;
  statuses: string[];
  defaultOverlapDays: number;
  /**
   * true: 워터마크 기반 증분 검색(`lastUpdatedDateRange`) + 그룹별 워터마크
   * 갱신을 적용한다.
   * false: 매 실행 전수 sweep. 워터마크를 사용하지도, 만들지도 않는다.
   * (예: IN_PROGRESS — 댓글 mutation이 `document.updatedAt`을 안 건드려서
   * 워터마크 검색만으로는 댓글 변화를 흡수 못 함)
   */
  incrementalEligible: boolean;
}

const CLOSED_STATUSES = new Set(["DONE", "DECLINED", "CANCELED"]);

/**
 * 디스크에 저장된 종결 문서 중 종결된 지 N일 이내인 것들을 detail 재조회로
 * sweep한다. 댓글 mutation은 `document.updatedAt`을 갱신하지 않으므로
 * 워터마크 검색만으론 종결 후 댓글 변화를 흡수할 수 없다. 종결 직후 일정
 * 시간 안에 달리는 댓글이 거의 전부이므로 N일(기본 30) 윈도우면 실무상
 * 충분하고, 더 오래된 doc은 acceptance criteria에 한계로 명시한다.
 *
 * 이미 같은 cycle에서 search → detail로 잡힌 doc(`collectedKeys.has`)은
 * 중복 fetch를 피하기 위해 skip한다.
 */
async function sweepRecentlyClosed(
  authCtx: AuthContext,
  config: Config,
  storage: StorageWriter,
  logger: Logger,
  detailBase: string,
  collectedKeys: Set<string>,
  result: CrawlResult,
): Promise<number> {
  const windowDays = config.closedSweepDays;
  const cutoffMs = Date.now() - windowDays * MS_PER_DAY;

  let existingKeys: Set<string>;
  try {
    existingKeys = await storage.listExistingInstanceKeys();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("closed sweep: 디스크 enumerate 실패 — sweep 생략", { error: message });
    result.errors.push({
      target: "instance-closed-sweep",
      phase: "list-existing",
      message,
      timestamp: nowISO(),
    });
    return 0;
  }

  // 메타 로드를 병렬화. 인스턴스 파일이 많을수록 순차 read는 매 cycle
  // O(N) I/O로 누적된다.
  const eligibleIds = [...existingKeys].filter((id) => !collectedKeys.has(id));
  const loaded = await pooledMap(eligibleIds, config.concurrency, async (id) => {
    try {
      return { id, inst: await storage.readInstance(id) };
    } catch (err) {
      // readInstance는 ENOENT/JSON parse 실패만 null로 swallow하고 나머지는
      // throw하기로 약속한다(권한/디스크 등). 한 파일 실패가 sweep 전체를
      // abort시키지 않게 하되, 운영자가 알 수 있도록 errors에는 push.
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`closed sweep: 인스턴스 메타 로드 실패: ${id}`, { error: message });
      result.errors.push({
        target: `instance-closed-sweep:${id}`,
        phase: "list-existing",
        message,
        timestamp: nowISO(),
      });
      return { id, inst: null };
    }
  });

  const candidates: Array<{ id: string; prior: WorkflowInstance }> = [];
  for (const { inst, id } of loaded) {
    if (!inst) continue;
    if (!CLOSED_STATUSES.has(inst.status)) continue;
    if (!inst.lastUpdatedAt) continue;
    const ms = Date.parse(inst.lastUpdatedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < cutoffMs) continue;
    candidates.push({ id, prior: inst });
  }

  if (candidates.length === 0) {
    logger.info("closed sweep: 윈도우 내 종결 문서 없음", { windowDays });
    return 0;
  }
  // 메인 검색 단계의 카운터와 일관되게 — sweep도 "처리 시도한 doc 수"를
  // totalCount에 더해야 success+failure ≤ total 불변량이 깨지지 않는다.
  result.totalCount += candidates.length;
  logger.info("closed sweep 시작", { windowDays, candidates: candidates.length });

  const hasPathParam = /\{[^}]+\}/.test(detailBase);
  let sweptCount = 0;

  await pooledMap(candidates, config.concurrency, async ({ id: docKey, prior }) => {
    try {
      const detailUrl = hasPathParam
        ? detailBase.replace(/\{[^}]+\}/, docKey)
        : `${detailBase}/${docKey}`;
      const detail = await withRetry(
        () => flexFetch<DocumentDetailResponse>(authCtx, detailUrl),
        { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
      );
      // 첨부는 이미 받았다고 가정하고 재다운로드 안 함 (sweep 비용 절감).
      // 댓글이 첨부 추가를 동반하는 케이스는 흔치 않고, 본문 변경은
      // updatedAt이 갱신되어 워터마크 search가 잡는다.
      // mapInstance는 detail 응답으로부터 fileName만 재구성할 수 있으므로,
      // 기존 instance가 보유한 localPath/fileSize/mimeType 같은 부가 메타는
      // fileKey 우선 매칭으로 이번 결과에 다시 채워준다. 같은 fileName 첨부
      // 두 개가 다른 fileKey로 존재할 수 있으므로 fileName-only 매칭은
      // mis-association 위험이 있다. fileKey가 어느 한쪽에라도 없을 때만
      // fileName 폴백을 쓴다.
      const priorRaw = prior._raw as
        | { document?: { attachments?: Array<{ file?: { fileKey?: unknown } }> } }
        | undefined;
      const priorRawAtts = priorRaw?.document?.attachments ?? [];
      const priorByFileKey = new Map<string, AttachmentInfo>();
      const priorByFileName = new Map<string, AttachmentInfo>();
      for (let i = 0; i < prior.attachments.length; i++) {
        const meta = prior.attachments[i];
        const fk = priorRawAtts[i]?.file?.fileKey;
        if (typeof fk === "string") priorByFileKey.set(fk, meta);
        priorByFileName.set(meta.fileName, meta);
      }
      const attachments = (detail.document.attachments ?? []).map((att) => {
        const byKey = att.file.fileKey ? priorByFileKey.get(att.file.fileKey) : undefined;
        return byKey ?? priorByFileName.get(att.file.fileName) ?? { fileName: att.file.fileName };
      });
      const instance = mapInstance(detail, attachments);
      await storage.saveInstance(instance);
      collectedKeys.add(docKey);
      result.successCount++;
      sweptCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failureCount++;
      result.errors.push({
        target: `instance-closed-sweep:${docKey}`,
        phase: "detail",
        message,
        timestamp: nowISO(),
      });
      logger.error(`closed sweep 실패: ${docKey}`, { error: message });
    }
  });

  logger.info("closed sweep 완료", {
    windowDays,
    candidates: candidates.length,
    swept: sweptCount,
    failed: candidates.length - sweptCount,
  });
  return sweptCount;
}

function computeDateRange(
  watermark: WatermarkGroupState | undefined,
  defaultOverlapDays: number,
  todayKst: string,
): DateRange | undefined {
  if (!watermark?.lastUpdatedAt) return undefined;
  const watermarkMs = Date.parse(watermark.lastUpdatedAt);
  // 워터마크 파일 손상/수동 편집으로 invalid timestamp가 들어오면 그 그룹은
  // 이번 실행을 풀크롤처럼 처리(undefined 반환)해서 자가복구되도록 한다.
  if (!Number.isFinite(watermarkMs)) return undefined;
  const overlapDays = watermark.overlapDays ?? defaultOverlapDays;
  const fromMs = watermarkMs - overlapDays * MS_PER_DAY;
  return { from: toKstDate(new Date(fromMs)), to: todayKst };
}

async function crawlSearchGroup(
  authCtx: AuthContext,
  config: Config,
  storage: StorageWriter,
  logger: Logger,
  result: CrawlResult,
  collectedKeys: Set<string>,
  searchUrl: string,
  detailBase: string,
  group: SearchGroup,
  dateRange: DateRange | undefined,
): Promise<string | null> {
  logger.info("인스턴스 검색 그룹 시작", {
    group: group.label,
    statuses: group.statuses,
    lastUpdatedDateRange: dateRange ?? null,
  });

  const groupStartedAt = Date.now();
  let continuationToken: string | undefined;
  let hasMore = true;
  let isFirstPage = true;
  // 이번 그룹에서 성공적으로 상세까지 가져온 문서들의 document.updatedAt
  // 최댓값. 워커가 동시에 갱신하므로 단순 비교/대입(JS 단일 스레드 보장).
  let groupMaxUpdatedAt: string | null = null;
  // detail/attachment/save 단계별 cumulative ms. 동시 처리이므로 모두 더하면
  // wall clock보다 크게 나온다 — 그래서 평균(=mean)과 카운트도 함께 노출해
  // "어디서 시간을 쓰는지"를 비교 가능하게 한다. 카운트는 단계별로 따로 세야
  // 한다: detail 실패 시 attachments/save는 시작도 안 하므로, detailCount로
  // 모든 mean을 나누면 attachments/save 평균이 저평가된다.
  const phaseTotals = { detailMs: 0, attachmentsMs: 0, saveMs: 0 };
  const phaseMaxes = { detailMs: 0, attachmentsMs: 0, saveMs: 0 };
  const phaseCounts = { detail: 0, attachments: 0, save: 0 };

  while (hasMore) {
    const searchBody = {
      filter: {
        statuses: group.statuses,
        templateKeys: [],
        writerHashedIds: [],
        approverTargets: [],
        referrerTargets: [],
        starred: false,
        ...(dateRange ? { lastUpdatedDateRange: dateRange } : {}),
      },
      search: { keyword: "", type: "ALL" },
    };

    const searchParams = new URLSearchParams({
      size: String(config.searchPageSize),
      sortType: "LAST_UPDATED_AT",
      direction: "DESC",
    });
    if (continuationToken) {
      searchParams.set("continuationToken", continuationToken);
    }

    const page = await withRetry(
      () => flexPost<SearchResponse>(
        authCtx,
        `${searchUrl}?${searchParams.toString()}`,
        searchBody,
      ),
      {
        maxRetries: config.maxRetries,
        delayMs: config.requestDelayMs,
        onRetry: () => result.retries++,
      },
    );

    const docs = page.documents ?? [];
    const firstDocKey = docs[0]?.document.documentKey ?? null;
    const lastDocKeyInPage = docs[docs.length - 1]?.document.documentKey ?? null;
    if (isFirstPage) {
      logger.info(`인스턴스 그룹 ${group.label}: 총 ${page.total}건의 문서 발견`);
      isFirstPage = false;
    }
    logger.info("인스턴스 페이지 수신", {
      group: group.label,
      statuses: group.statuses,
      total: page.total,
      hasNext: page.hasNext,
      docsInPage: docs.length,
      requestContinuationToken: continuationToken ?? null,
      firstDocumentKey: firstDocKey,
      lastDocumentKeyInPage: lastDocKeyInPage,
      nextContinuationToken: page.continuationToken ?? null,
    });

    // 같은 페이지 내 docKey들을 동시 처리. collectedKeys 중복은 미리 거른다.
    const newDocs = docs.filter((d) => !collectedKeys.has(d.document.documentKey));
    const newInPage = newDocs.length;
    result.totalCount += newInPage;

    await pooledMap(newDocs, config.concurrency, async (doc) => {
      const docKey = doc.document.documentKey;
      // 실패한 단계를 정확히 에러 레코드에 남기기 위한 추적자. 단계별 finally
      // 안에서 phase 누적도 함께 일어나므로, 실패한 문서의 시간도 phase totals/
      // max에 반영되어 "에러 케이스가 병목을 숨기는" 케이스를 피한다.
      let currentPhase: "detail" | "attachments" | "save" = "detail";
      try {
        const hasPathParam = /\{[^}]+\}/.test(detailBase);
        const detailUrl = hasPathParam
          ? detailBase.replace(/\{[^}]+\}/, docKey)
          : `${detailBase}/${docKey}`;

        const detailStart = Date.now();
        let detail: DocumentDetailResponse;
        try {
          detail = await withRetry(
            () => flexFetch<DocumentDetailResponse>(authCtx, detailUrl),
            {
              maxRetries: config.maxRetries,
              delayMs: config.requestDelayMs,
              onRetry: () => result.retries++,
            },
          );
        } finally {
          const detailMs = Date.now() - detailStart;
          phaseTotals.detailMs += detailMs;
          if (detailMs > phaseMaxes.detailMs) phaseMaxes.detailMs = detailMs;
          phaseCounts.detail++;
        }

        currentPhase = "attachments";
        const attachStart = Date.now();
        let attachments: AttachmentInfo[];
        try {
          attachments = await processAttachments(
            authCtx, config, docKey, detail.document.attachments ?? [], storage, logger,
          );
        } finally {
          const attachMs = Date.now() - attachStart;
          phaseTotals.attachmentsMs += attachMs;
          if (attachMs > phaseMaxes.attachmentsMs) phaseMaxes.attachmentsMs = attachMs;
          phaseCounts.attachments++;
        }

        currentPhase = "save";
        const instance = mapInstance(detail, attachments);
        const saveStart = Date.now();
        try {
          await storage.saveInstance(instance);
        } finally {
          const saveMs = Date.now() - saveStart;
          phaseTotals.saveMs += saveMs;
          if (saveMs > phaseMaxes.saveMs) phaseMaxes.saveMs = saveMs;
          phaseCounts.save++;
        }

        const observed = detail.document.updatedAt ?? null;
        if (isLaterIso(observed, groupMaxUpdatedAt)) {
          groupMaxUpdatedAt = observed;
        }
        collectedKeys.add(docKey);
        result.successCount++;
      } catch (error) {
        collectedKeys.add(docKey);
        result.failureCount++;
        result.errors.push({
          target: `instance:${docKey}`,
          phase: currentPhase,
          message: error instanceof Error ? error.message : String(error),
          timestamp: nowISO(),
        });
        logger.error(`인스턴스 수집 실패: ${docKey}`, {
          phase: currentPhase,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        logger.progress(
          "인스턴스 수집",
          result.successCount + result.failureCount,
        );
      }
    });

    logger.info("인스턴스 페이지 처리 완료", {
      group: group.label,
      totalCollected: result.totalCount,
      successCount: result.successCount,
      failureCount: result.failureCount,
      newInPage,
      hasNext: page.hasNext,
      nextContinuationTokenCandidate: page.continuationToken ?? null,
    });

    hasMore = page.hasNext && docs.length > 0;
    if (!hasMore) {
      continue;
    }

    const nextContinuationToken = page.continuationToken;
    if (!nextContinuationToken) {
      logger.warn("continuationToken 없음 — 페이지네이션 종료", { group: group.label });
      hasMore = false;
      continue;
    }

    if (nextContinuationToken === continuationToken) {
      logger.warn("continuationToken 정체 — 페이지네이션 종료", { group: group.label });
      hasMore = false;
      continue;
    }

    continuationToken = nextContinuationToken;
  }

  // 단계별 소요시간 요약. mean은 해당 단계가 실제로 시작된 횟수로 나눈다 —
  // detail 실패 시 attachments/save는 시작도 안 하므로 attachments/save mean을
  // detailCount로 나누면 저평가된다. wall은 실제 그룹 wall-clock으로,
  // sum/wall 비율이 ~concurrency에 가까워야 그 단계가 진짜 병목.
  const groupWallMs = Date.now() - groupStartedAt;
  const meanOf = (totalMs: number, count: number): number =>
    count > 0 ? Math.round(totalMs / count) : 0;
  logger.info("인스턴스 그룹 단계별 소요시간", {
    group: group.label,
    docs: phaseCounts.detail,
    wallMs: groupWallMs,
    detail: {
      count: phaseCounts.detail,
      totalMs: phaseTotals.detailMs,
      meanMs: meanOf(phaseTotals.detailMs, phaseCounts.detail),
      maxMs: phaseMaxes.detailMs,
    },
    attachments: {
      count: phaseCounts.attachments,
      totalMs: phaseTotals.attachmentsMs,
      meanMs: meanOf(phaseTotals.attachmentsMs, phaseCounts.attachments),
      maxMs: phaseMaxes.attachmentsMs,
    },
    save: {
      count: phaseCounts.save,
      totalMs: phaseTotals.saveMs,
      meanMs: meanOf(phaseTotals.saveMs, phaseCounts.save),
      maxMs: phaseMaxes.saveMs,
    },
    concurrency: config.concurrency,
  });

  return groupMaxUpdatedAt;
}

// --- flex API 응답 타입 ---

interface SearchResponse {
  hasNext: boolean;
  total: number;
  continuationToken?: string;
  documents: Array<{
    document: {
      documentKey: string;
      code: string;
      templateKey: string;
      status: string;
      emoji?: string;
      title: string;
      simpleContent?: string;
      writer: { idHash: string; name: string; profileImageUrl?: string };
      writtenAt: string;
      lastUpdatedAt?: string;
      inputFields?: Array<{
        idHash: string;
        value: string;
        inputField: { idHash: string; name: string; type: string; data?: string };
      }>;
    };
    approvalProcess?: {
      status: string;
      lines: Array<{
        step: number;
        status: string;
        actors: Array<{
          resolvedTarget: { type: string; displayName: string; userIdHashes?: string[] };
          status: string;
          actedUserIdHash?: string;
          actedAt?: string;
        }>;
      }>;
    };
  }>;
}

export interface DocumentDetailResponse {
  document: {
    documentKey: string;
    code: string;
    templateKey: string;
    status: string;
    emoji?: string;
    title: string;
    writer: { idHash: string; name: string; profileImageUrl?: string };
    writtenAt: string;
    inputs: Array<{
      idHash: string;
      value: string;
      inputField: {
        idHash: string;
        name: string;
        displayOrder: number;
        type: string;
        data?: string;
        required?: boolean;
      };
    }>;
    attachments?: Array<{
      idHash: string;
      file: {
        fileKey: string;
        fileName: string;
        downloadUrl: string;
      };
    }>;
    content?: string;
    comments?: Array<{
      idHash: string;
      writer: { idHash: string; name: string };
      type: string;
      title?: string;
      content?: string;
      writtenBySystem?: boolean;
      createdAt: string;
      updatedAt?: string;
    }>;
    createdAt?: string;
    updatedAt?: string;
  };
  approvalProcess?: {
    status: string;
    lines: Array<{
      step: number;
      status: string;
      actors: Array<{
        resolvedTarget: { type: string; displayName: string; userIdHashes?: string[] };
        status: string;
        actedUserIdHash?: string;
        actedAt?: string;
      }>;
    }>;
    referrers?: Array<{
      resolvedTarget: { type: string; displayName: string };
    }>;
    requestedAt?: string;
    terminatedAt?: string;
  };
}

function mapInstance(detail: DocumentDetailResponse, attachments: AttachmentInfo[]): WorkflowInstance {
  const doc = detail.document;
  const process = detail.approvalProcess;

  const fields: FieldValue[] = (doc.inputs ?? []).map((input) => ({
    fieldName: input.inputField.name,
    fieldType: input.inputField.type,
    value: input.value,
  }));

  const approvalLine: ApprovalStep[] = (process?.lines ?? []).flatMap((line) =>
    line.actors.map((actor) => ({
      order: line.step,
      type: actor.resolvedTarget.type,
      approver: { name: actor.resolvedTarget.displayName },
      status: actor.status,
      processedAt: actor.actedAt,
    })),
  );

  return {
    id: doc.documentKey,
    documentNumber: doc.code,
    templateId: doc.templateKey,
    templateName: doc.templateKey,
    drafter: { id: doc.writer.idHash, name: doc.writer.name },
    draftedAt: doc.writtenAt,
    lastUpdatedAt: doc.updatedAt ?? null,
    signatureHash: computeSignatureHash(detail),
    status: doc.status,
    approvalLine,
    fields,
    attachments,
    modificationHistory: doc.comments?.filter((c) => !c.writtenBySystem).map((c) => ({
      modifiedBy: { id: c.writer.idHash, name: c.writer.name },
      modifiedAt: c.createdAt,
      description: c.content || c.title,
    })),
    _raw: detail,
  };
}

/**
 * 다운스트림 변경 감지용 sha1 hash. `document.updatedAt`이 댓글 mutation을
 * 반영하지 않는 한계를 보완한다 — 같은 doc 두 번 fetch 시 댓글이 추가/수정/
 * 삭제됐으면 hash가 바뀐다. 단순 `comments.length`만 비교하면 (i) 같은 cycle
 * 내 add+delete (ii) 댓글 내용 수정만 발생, 두 케이스에서 false negative.
 *
 * Input shape (longfin's recommendation in planetarium/reflex#38):
 *   document.updatedAt | document.status | approvalProcess.status |
 *   comments.length | max(comments[].updatedAt ?? comments[].createdAt) |
 *   sorted(comments[].idHash).join(",")
 */
export function computeSignatureHash(detail: DocumentDetailResponse): string {
  const doc = detail.document;
  const comments = doc.comments ?? [];
  let commentMaxStamp: string | null = null;
  for (const c of comments) {
    const stamp = c.updatedAt ?? c.createdAt;
    // Lexicographic compare on ISO strings is unsafe across `...00Z` vs
    // `...00.500Z` mixes — use the same epoch-ms helper the watermark
    // commit logic uses, so signature stays stable across millisecond
    // formatting drift.
    if (isLaterIso(stamp, commentMaxStamp)) {
      commentMaxStamp = stamp ?? null;
    }
  }
  const commentIds = comments.map((c) => c.idHash).sort().join(",");
  const payload = JSON.stringify([
    doc.updatedAt ?? null,
    doc.status,
    detail.approvalProcess?.status ?? null,
    comments.length,
    commentMaxStamp,
    commentIds,
  ]);
  return createHash("sha1").update(payload).digest("hex");
}

async function processAttachments(
  authCtx: AuthContext,
  config: Config,
  instanceId: string,
  rawAttachments: Array<{ idHash: string; file: { fileKey: string; fileName: string; downloadUrl: string } }>,
  storage: StorageWriter,
  logger: Logger,
): Promise<AttachmentInfo[]> {
  if (rawAttachments.length === 0) return [];

  return pooledMap(rawAttachments, config.attachmentConcurrency, async (att) => {
    const info: AttachmentInfo = { fileName: att.file.fileName };

    if (!config.downloadAttachments) return info;

    try {
      const response = await fetch(att.file.downloadUrl, { headers: apiHeaders(authCtx) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${att.file.downloadUrl}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      info.localPath = await storage.saveAttachment(
        instanceId, att.file.fileName, buffer, att.file.fileKey,
      );
    } catch (error) {
      info.downloadError = error instanceof Error ? error.message : String(error);
      logger.warn(`첨부파일 다운로드 실패: ${att.file.fileName}`, { instanceId });
    }
    return info;
  });
}
