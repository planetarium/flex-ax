import type { AuthContext } from "../auth/index.js";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import type { StorageWriter } from "../storage/index.js";
import type { ApiCatalog } from "../types/catalog.js";
import type { WorkflowTemplate, TemplateField } from "../types/template.js";
import {
  type CrawlResult,
  emptyCrawlResult,
  nowISO,
  withRetry,
  flexFetch,
  resolveUrl,
  pooledMap,
} from "./shared.js";

export async function crawlTemplates(
  authCtx: AuthContext,
  config: Config,
  catalog: ApiCatalog | null,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult> {
  const startTime = Date.now();
  const result = emptyCrawlResult();

  logger.info("양식(템플릿) 수집 시작");

  const listUrl = resolveUrl(
    config.flexBaseUrl, catalog, "template-list",
    "/api/v3/approval-document-template/templates",
  );

  try {
    const data = await withRetry(
      () => flexFetch<{ templates: RawTemplate[] }>(authCtx, listUrl),
      { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
    );

    const rawTemplates = data.templates ?? [];
    result.totalCount = rawTemplates.length;
    logger.info(`양식 ${rawTemplates.length}건 발견 (concurrency=${config.concurrency})`);

    let processed = 0;
    await pooledMap(rawTemplates, config.concurrency, async (raw) => {
      try {
        const detailUrl = resolveUrl(
          config.flexBaseUrl, catalog, "template-detail",
          "/api/v3/approval-document-template/templates",
        ).replace(/\{[^}]+\}/, raw.templateKey) +
          (catalog ? "" : `/${raw.templateKey}`);

        // 카탈로그의 urlPattern에 {param}이 있으면 replace로 처리됨
        // 폴백일 때는 직접 경로 추가
        const finalDetailUrl = detailUrl.includes(raw.templateKey)
          ? detailUrl
          : `${config.flexBaseUrl}/api/v3/approval-document-template/templates/${raw.templateKey}`;

        const detail = await withRetry(
          () => flexFetch<{ template: RawTemplateDetail }>(authCtx, finalDetailUrl),
          { maxRetries: config.maxRetries, delayMs: config.requestDelayMs },
        );

        const template = mapTemplate(raw, detail.template);
        await storage.saveTemplate(template);
        result.successCount++;
      } catch (error) {
        // 상세 실패 — 목록 데이터로 저장 시도하되, 에러는 기록
        logger.warn(`양식 상세 조회 실패 (목록 데이터로 저장): ${raw.name}`, {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          const template = mapTemplate(raw, null);
          await storage.saveTemplate(template);
          result.successCount++;
        } catch (saveError) {
          result.failureCount++;
          result.errors.push({
            target: `template:${raw.templateKey}:${raw.name}`,
            phase: "save",
            message: saveError instanceof Error ? saveError.message : String(saveError),
            timestamp: nowISO(),
          });
          logger.error(`양식 수집 실패: ${raw.name}`, {
            error: saveError instanceof Error ? saveError.message : String(saveError),
          });
        }
      } finally {
        processed++;
        logger.progress("양식 수집", processed, rawTemplates.length);
      }
    });
  } catch (error) {
    logger.error("양식 목록 수집 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    result.errors.push({
      target: "template-list",
      phase: "list",
      message: error instanceof Error ? error.message : String(error),
      timestamp: nowISO(),
    });
  }

  result.durationMs = Date.now() - startTime;
  logger.info(`\n양식 수집 완료: 성공 ${result.successCount}, 실패 ${result.failureCount}`);
  return result;
}

// --- flex API 응답 타입 ---

interface RawTemplate {
  templateKey: string;
  name: string;
  description?: string;
  emoji?: string;
  onlyVisibleForAdmin?: boolean;
  tags?: Array<{ idHash: string; name: string; displayOrder: number }>;
  createdAt?: string;
  updatedAt?: string;
}

interface RawTemplateDetail {
  templateKey: string;
  name: string;
  inputFields?: Array<{
    idHash: string;
    name: string;
    displayOrder: number;
    type: string;
    data?: string;
    required?: boolean;
    prefill?: { defaultValue: string; type: string };
  }>;
  approvalProcess?: {
    lines?: Array<{
      step: number;
      actors: Array<{
        resolvedTarget: {
          type: string;
          value: string;
          displayName: string;
        };
      }>;
    }>;
  };
}

function mapTemplate(raw: RawTemplate, detail: RawTemplateDetail | null): WorkflowTemplate {
  const fields: TemplateField[] = (detail?.inputFields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    description: f.data ? tryParseFieldData(f.data) : undefined,
  }));

  const defaultApprovalLine = detail?.approvalProcess?.lines?.map((line) => ({
    order: line.step,
    type: "승인",
    approver: {
      name: line.actors.map((a) => a.resolvedTarget.displayName).join(", "),
    },
    status: "pending" as const,
  }));

  return {
    id: raw.templateKey,
    name: raw.name,
    category: raw.tags?.map((t) => t.name).join(", ") || undefined,
    fields,
    defaultApprovalLine: defaultApprovalLine?.length ? defaultApprovalLine : undefined,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    _raw: { list: raw, detail },
  };
}

function tryParseFieldData(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data);
    if (parsed.currencyCode) return `currency: ${parsed.currencyCode}`;
    return undefined;
  } catch {
    return data || undefined;
  }
}
