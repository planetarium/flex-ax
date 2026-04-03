import type { AuthContext } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { StorageWriter } from "../storage/index.js";
import type { ApiCatalog } from "../types/catalog.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { ApprovalStep, AttachmentInfo, FieldValue } from "../types/common.js";
import {
  type CrawlResult,
  delay,
  emptyCrawlResult,
  nowISO,
  withRetry,
  flexFetch,
  flexPost,
  resolveUrl,
} from "./shared.js";

export async function crawlInstances(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult & { collectedKeys: Set<string> }> {
  const startTime = Date.now();
  const result = emptyCrawlResult();
  const collectedKeys = new Set<string>();

  logger.info("인스턴스(결재 문서) 수집 시작");

  const searchUrl = resolveUrl(
    config.flexBaseUrl, catalog, "instance-search",
    "/action/v3/approval-document/user-boxes/search",
  );

  try {
    const statuses = ["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"];
    let lastDocumentKey: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const searchBody = {
        filter: {
          statuses,
          templateKeys: [],
          writerHashedIds: [],
          approverTargets: [],
          referrerTargets: [],
          starred: false,
        },
        search: { keyword: "", type: "ALL" },
        ...(lastDocumentKey ? { lastDocumentKey } : {}),
      };

      const page = await withRetry(
        () => flexPost<SearchResponse>(
          authCtx,
          `${searchUrl}?size=20&sortType=LAST_UPDATED_AT&direction=DESC`,
          searchBody,
        ),
        { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
      );

      const docs = page.documents ?? [];
      if (result.totalCount === 0) {
        logger.info(`총 ${page.total}건의 문서 발견`);
      }

      let newInPage = 0;
      for (const doc of docs) {
        const docKey = doc.document.documentKey;

        // 중복 스킵
        if (collectedKeys.has(docKey)) {
          continue;
        }

        result.totalCount++;
        newInPage++;

        try {
          logger.progress("인스턴스 수집", result.successCount + result.failureCount + 1, page.total);

          const detailBase = resolveUrl(
            config.flexBaseUrl, catalog, "instance-detail",
            "/api/v3/approval-document/approval-documents",
          );
          const detailUrl = `${detailBase.replace(/\{[^}]+\}/, docKey)}${detailBase.includes(docKey) ? "" : `/${docKey}`}`;

          const detail = await withRetry(
            () => flexFetch<DocumentDetailResponse>(authCtx, detailUrl),
            { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
          );

          const attachments = await processAttachments(
            authCtx, config, docKey, detail.document.attachments ?? [], storage, logger,
          );

          const instance = mapInstance(detail, attachments);
          await storage.saveInstance(instance);
          collectedKeys.add(docKey);
          result.successCount++;
        } catch (error) {
          collectedKeys.add(docKey); // 실패해도 재시도 방지
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

        await delay(config.requestDelayMs);
      }

      // 이 페이지에 새 문서가 없으면 커서가 전진 안 하는 것 → 종료
      if (newInPage === 0) {
        logger.warn("새 문서 없음 — 페이지네이션 종료");
        hasMore = false;
      } else {
        hasMore = page.hasNext && docs.length > 0;
        if (hasMore) {
          lastDocumentKey = docs[docs.length - 1].document.documentKey;
        }
      }
    }
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
  config: Config,
  instanceId: string,
  rawAttachments: Array<{ idHash: string; file: { fileKey: string; fileName: string; downloadUrl: string } }>,
  storage: StorageWriter,
  logger: Logger,
): Promise<AttachmentInfo[]> {
  const results: AttachmentInfo[] = [];

  for (const att of rawAttachments) {
    const info: AttachmentInfo = { fileName: att.file.fileName };

    if (config.downloadAttachments) {
      try {
        const buffer = await authCtx.page.evaluate(
          async ([url, headers]) => {
            const res = await fetch(url, { headers: headers as Record<string, string> });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
            const ab = await res.arrayBuffer();
            return Array.from(new Uint8Array(ab));
          },
          [att.file.downloadUrl, authCtx.authHeaders] as const,
        );

        const savedPath = await storage.saveAttachment(
          instanceId, att.file.fileName, Buffer.from(buffer),
        );
        info.localPath = savedPath;
      } catch (error) {
        info.downloadError = error instanceof Error ? error.message : String(error);
        logger.warn(`첨부파일 다운로드 실패: ${att.file.fileName}`, { instanceId });
      }
    }

    results.push(info);
  }

  return results;
}
