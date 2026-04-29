import { type AuthContext, apiHeaders } from "../auth/index.js";
import type { CrawlerConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { StorageWriter } from "../storage/index.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { ApprovalStep, AttachmentInfo, FieldValue } from "../types/common.js";
import {
  type CrawlResult,
  emptyCrawlResult,
  nowISO,
  withRetry,
  flexFetch,
  flexPost,
  pooledMap,
} from "./shared.js";

/** 수집된 문서 key 목록을 반환 (근태/휴가 크롤러의 중복 판별용) */
export async function crawlInstances(
  authCtx: AuthContext,
  config: CrawlerConfig,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult & { collectedKeys: Set<string> }> {
  const startTime = Date.now();
  const result = emptyCrawlResult();
  const collectedKeys = new Set<string>();

  logger.info("인스턴스(결재 문서) 수집 시작");

  try {
    // 이 endpoint는 size 파라미터만 페이지네이션으로 동작하고
    // lastDocumentKey/page/offset 류는 모두 무시한다. (probe-pagination 으로 확인.)
    // 따라서 충분히 큰 size로 한 번에 받는 방식을 쓴다.
    const searchBody = {
      filter: {
        statuses: ["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"],
        templateKeys: [],
        writerHashedIds: [],
        approverTargets: [],
        referrerTargets: [],
        starred: false,
      },
      search: { keyword: "", type: "ALL" },
    };

    const page = await withRetry(
      () =>
        flexPost<SearchResponse>(
          authCtx,
          `${config.flexBaseUrl}/action/v3/approval-document/user-boxes/search?size=${config.searchPageSize}&sortType=LAST_UPDATED_AT&direction=DESC`,
          searchBody,
        ),
      { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
    );

    const docs = page.documents ?? [];
    result.totalCount = docs.length;
    logger.info(
      `총 ${page.total}건의 문서 발견 (받음: ${docs.length}, concurrency=${config.concurrency})`,
    );
    if (page.hasNext || docs.length < page.total) {
      logger.warn(
        `검색 결과가 SEARCH_PAGE_SIZE(${config.searchPageSize})보다 큽니다. ` +
          `놓친 문서가 있을 수 있어요 — SEARCH_PAGE_SIZE를 ${page.total} 이상으로 올려서 다시 실행하세요.`,
      );
    }

    await pooledMap(docs, config.concurrency, async (doc) => {
      const docKey = doc.document.documentKey;
      try {
        const detail = await withRetry(
          () =>
            flexFetch<DocumentDetailResponse>(
              authCtx,
              `${config.flexBaseUrl}/api/v3/approval-document/approval-documents/${docKey}`,
            ),
          { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
        );

        const attachments = await processAttachments(
          authCtx,
          config,
          docKey,
          detail.document.attachments ?? [],
          storage,
          logger,
        );

        const instance = mapInstance(detail, attachments);
        await storage.saveInstance(instance);
        collectedKeys.add(docKey);
        result.successCount++;
        logger.progress(
          "인스턴스 수집",
          result.successCount + result.failureCount,
          result.totalCount,
        );
      } catch (error) {
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
      }
    });
  } catch (error) {
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

  result.durationMs = Date.now() - startTime;
  logger.info(`\n인스턴스 수집 완료: 성공 ${result.successCount}, 실패 ${result.failureCount}`);
  return { ...result, collectedKeys };
}

// --- flex API 응답 타입 ---

interface SearchResponse {
  hasNext: boolean;
  total: number;
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
    line.actors.map((actor, idx) => ({
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
    templateName: doc.title,
    drafter: { id: doc.writer.idHash, name: doc.writer.name },
    draftedAt: doc.writtenAt,
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
  config: CrawlerConfig,
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
      const res = await fetch(att.file.downloadUrl, { headers: apiHeaders(authCtx) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${att.file.downloadUrl}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      info.localPath = await storage.saveAttachment(instanceId, att.file.fileName, buffer);
    } catch (error) {
      info.downloadError = error instanceof Error ? error.message : String(error);
      logger.warn(`첨부파일 다운로드 실패: ${att.file.fileName}`, { instanceId });
    }
    return info;
  });
}
