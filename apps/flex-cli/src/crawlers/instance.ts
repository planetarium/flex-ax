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
  CrawlResult & { collectedKeys: Set<string>; missingKeys: string[] }
> {
  const startTime = Date.now();
  const result = emptyCrawlResult();
  const collectedKeys = new Set<string>();
  // full recon이 아닐 땐 의미가 없으므로 비워둔다 (incremental은 변경된
  // 문서만 재방문하니 disk-vs-collected diff는 거짓양성 폭증).
  let missingKeys: string[] = [];

  logger.info("인스턴스(결재 문서) 수집 시작", { mode });

  const searchUrl = resolveUrl(
    config.flexBaseUrl, catalog, "instance-search",
    "/action/v3/approval-document/user-boxes/search",
  );
  const detailBase = resolveUrl(
    config.flexBaseUrl, catalog, "instance-detail",
    "/api/v3/approval-document/approval-documents",
  );

  const searchGroups: SearchGroup[] = [
    { label: "in-progress", statuses: ["IN_PROGRESS"], defaultOverlapDays: 1 },
    { label: "done", statuses: ["DONE", "DECLINED", "CANCELED"], defaultOverlapDays: 2 },
  ];

  const watermarks = await storage.loadWatermarks();
  const domainState: WatermarkDomainState =
    watermarks[APPROVAL_DOCUMENTS_DOMAIN] ?? { groups: {} };
  // 모든 그룹에 워터마크가 모두 비어 있다면 부트스트랩 — 사실상 풀크롤로 동작.
  const noWatermarks = searchGroups.every(
    (g) => !domainState.groups[g.label]?.lastUpdatedAt,
  );
  const effectiveFull = mode === "full" || noWatermarks;
  if (mode === "incremental" && noWatermarks) {
    logger.info("워터마크 없음 — bootstrap 풀크롤로 진행");
  }
  // to 날짜는 그룹 진입 전에 한 번 캡처해서 페이지/그룹 간 일관되게 사용.
  const todayKst = toKstDate(new Date());

  // full reconciliation diff: effectiveFull일 때만 시작 시점의 디스크 상
  // docKey 집합을 캡처해두고, 종료 후 collectedKeys와 차집합을 missing
  // 후보로 보고서에 노출. 자동 tombstone은 별도 트랙.
  let existingBeforeRun: Set<string> | null = null;
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

  // list-stage(검색 단계)가 try 끝까지 도달했는지 추적. crawlSearchGroup이
  // 재시도 후에도 throw하면 catch에서 false로 전환. failureCount는 doc 단위
  // 실패만 세므로 list 자체가 깨진 케이스를 별도로 표시해둬야 한다.
  let listStageOk = true;

  try {
    for (const group of searchGroups) {
      const existing = domainState.groups[group.label];
      const dateRange = effectiveFull
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
      //   - 그룹 내 실패가 단 1건이라도 있으면 갱신 보류 (다음 실행에서 재시도)
      //   - 후퇴 금지 — 새 max가 기존보다 작으면 기존 lastUpdatedAt 유지
      //   - 0건 처리됐어도 그룹 자체가 클린하게 끝났으면 lastSuccessfulRunAt은 갱신
      if (groupFailure === 0) {
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

  // 사실상 풀크롤로 돌았고 list 단계가 끝까지 살아남았으며 인스턴스 단계에
  // 단 1건의 실패도 없었을 때만 lastFullReconAt 갱신. 실패/list-throw가 섞이면
  // "전체 recon 완료" 의미가 흐려지므로, 후속 cadence-기반 자동 풀크롤
  // 트리거가 사고로 다음 실행을 건너뛰지 않도록 보수적으로 잠근다. 정당한
  // 0건(워크스페이스에 문서 없음, 권한 없음 등)도 클린한 recon이므로 stamp
  // 대상이다 — successCount는 게이트하지 않는다.
  if (effectiveFull && listStageOk && result.failureCount === 0) {
    domainState.lastFullReconAt = nowISO();
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
  return { ...result, collectedKeys, missingKeys };
}

interface SearchGroup {
  label: string;
  statuses: string[];
  defaultOverlapDays: number;
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
  // "어디서 시간을 쓰는지"를 비교 가능하게 한다.
  const phaseTotals = { detailMs: 0, attachmentsMs: 0, saveMs: 0 };
  let detailCount = 0;
  let detailMaxMs = 0;

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
      try {
        const hasPathParam = /\{[^}]+\}/.test(detailBase);
        const detailUrl = hasPathParam
          ? detailBase.replace(/\{[^}]+\}/, docKey)
          : `${detailBase}/${docKey}`;

        const detailStart = Date.now();
        const detail = await withRetry(
          () => flexFetch<DocumentDetailResponse>(authCtx, detailUrl),
          {
            maxRetries: config.maxRetries,
            delayMs: config.requestDelayMs,
            onRetry: () => result.retries++,
          },
        );
        const detailMs = Date.now() - detailStart;
        phaseTotals.detailMs += detailMs;
        if (detailMs > detailMaxMs) detailMaxMs = detailMs;
        detailCount++;

        const attachStart = Date.now();
        const attachments = await processAttachments(
          authCtx, config, docKey, detail.document.attachments ?? [], storage, logger,
        );
        phaseTotals.attachmentsMs += Date.now() - attachStart;

        const instance = mapInstance(detail, attachments);
        const saveStart = Date.now();
        await storage.saveInstance(instance);
        phaseTotals.saveMs += Date.now() - saveStart;
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
          phase: "detail",
          message: error instanceof Error ? error.message : String(error),
          timestamp: nowISO(),
        });
        logger.error(`인스턴스 수집 실패: ${docKey}`, {
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

  // 단계별 소요시간 요약. detailCount=0 이면 평균이 의미 없으니 0으로 둔다.
  // mean은 동시성에 영향을 받지 않는 per-document 비용. wall은 실제 그룹
  // wall-clock. wall-mean 비율이 ~concurrency에 가까워야 detail이 진짜 병목.
  const groupWallMs = Date.now() - groupStartedAt;
  const detailMean = detailCount > 0 ? phaseTotals.detailMs / detailCount : 0;
  const attachmentsMean = detailCount > 0 ? phaseTotals.attachmentsMs / detailCount : 0;
  const saveMean = detailCount > 0 ? phaseTotals.saveMs / detailCount : 0;
  logger.info("인스턴스 그룹 단계별 소요시간", {
    group: group.label,
    docs: detailCount,
    wallMs: groupWallMs,
    detail: {
      totalMs: phaseTotals.detailMs,
      meanMs: Math.round(detailMean),
      maxMs: detailMaxMs,
    },
    attachments: { totalMs: phaseTotals.attachmentsMs, meanMs: Math.round(attachmentsMean) },
    save: { totalMs: phaseTotals.saveMs, meanMs: Math.round(saveMean) },
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

interface DocumentDetailResponse {
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
