import { flexFetch, flexPost, withRetry } from "../crawlers/shared.js";
import { withLiveCommandContext } from "./live-common.js";

interface DocumentOpts {
  customer?: string;
  statuses: string[];
  box: "all" | "in-progress" | "done";
  limit: number;
  keyword: string;
  positional: string[];
}

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
      title: string;
      simpleContent?: string;
      writer: { idHash: string; name: string };
      writtenAt: string;
      lastUpdatedAt?: string;
    };
    approvalProcess?: {
      status: string;
      lines: Array<{
        step: number;
        status: string;
        actors: Array<{
          resolvedTarget: { type: string; displayName: string };
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
    title: string;
    writer: { idHash: string; name: string };
    writtenAt: string;
    inputs: Array<{
      idHash: string;
      value: string;
      inputField: {
        idHash: string;
        name: string;
        displayOrder: number;
        type: string;
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

export async function runDocument(argv: string[] = process.argv.slice(3)): Promise<void> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case "list":
      await cmdList(rest);
      return;
    case "show":
      await cmdShow(rest);
      return;
    case "attachments":
      await cmdAttachments(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      process.exit(sub === undefined ? 1 : 0);
    default:
      console.error(`[FLEX-AX:DOCUMENT:ERROR] 알 수 없는 서브커맨드: ${sub}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: flex-ax document <subcommand>

Subcommands:
  list                          결재 문서 목록 조회
  show <documentKey>            결재 문서 상세 조회
  attachments <documentKey>     첨부파일 목록 조회

Options:
  --customer <customerIdHash>   대상 법인 지정
  --box <all|in-progress|done>  기본 상태 그룹 (기본: all)
  --status <A,B,...>            상태 직접 지정 (예: IN_PROGRESS,DONE)
  --keyword <text>              제목/본문 검색어
  --limit <n>                   최대 결과 수 (기본: 50)

Examples:
  flex-ax document list
  flex-ax document list --box in-progress --limit 20
  flex-ax document show 8d2f...
  flex-ax document attachments 8d2f...
`);
}

function parseOpts(args: string[], defaultLimit: number): DocumentOpts {
  const opts: DocumentOpts = {
    statuses: [],
    box: "all",
    limit: defaultLimit,
    keyword: "",
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--customer") {
      opts.customer = args[++i];
    } else if (arg === "--box") {
      const value = args[++i];
      if (value !== "all" && value !== "in-progress" && value !== "done") {
        throw new Error(`지원하지 않는 --box 값입니다: ${value}`);
      }
      opts.box = value;
    } else if (arg === "--status") {
      opts.statuses = (args[++i] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    } else if (arg === "--keyword") {
      opts.keyword = args[++i] ?? "";
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
  const opts = parseOpts(args, 50);
  await withLiveCommandContext("DOCUMENT", opts, async ({ authCtx, config }) => {
    const rows = await searchDocuments(authCtx, config.flexBaseUrl, {
      statuses: resolveStatuses(opts),
      keyword: opts.keyword,
      limit: opts.limit,
      maxRetries: config.maxRetries,
      delayMs: config.requestDelayMs,
    });
    console.log(JSON.stringify(rows.map(toDocumentSummary), null, 2));
  });
}

async function cmdShow(args: string[]): Promise<void> {
  const opts = parseOpts(args, 50);
  const documentKey = opts.positional[0];
  if (!documentKey) {
    console.error("[FLEX-AX:DOCUMENT:ERROR] show 대상 documentKey를 지정하세요.");
    process.exit(1);
  }

  await withLiveCommandContext("DOCUMENT", opts, async ({ authCtx, config }) => {
    const detail = await fetchDocumentDetail(
      authCtx,
      config.flexBaseUrl,
      documentKey,
      config.maxRetries,
      config.requestDelayMs,
    );
    console.log(JSON.stringify(toDocumentDetail(detail), null, 2));
  });
}

async function cmdAttachments(args: string[]): Promise<void> {
  const opts = parseOpts(args, 50);
  const documentKey = opts.positional[0];
  if (!documentKey) {
    console.error("[FLEX-AX:DOCUMENT:ERROR] attachments 대상 documentKey를 지정하세요.");
    process.exit(1);
  }

  await withLiveCommandContext("DOCUMENT", opts, async ({ authCtx, config }) => {
    const detail = await fetchDocumentDetail(
      authCtx,
      config.flexBaseUrl,
      documentKey,
      config.maxRetries,
      config.requestDelayMs,
    );
    const attachments = (detail.document.attachments ?? []).map((attachment) => ({
      id: attachment.idHash,
      fileKey: attachment.file.fileKey,
      fileName: attachment.file.fileName,
      downloadUrl: attachment.file.downloadUrl,
    }));
    console.log(JSON.stringify(attachments, null, 2));
  });
}

function resolveStatuses(opts: DocumentOpts): string[] {
  if (opts.statuses.length > 0) {
    return opts.statuses;
  }
  if (opts.box === "in-progress") {
    return ["IN_PROGRESS"];
  }
  if (opts.box === "done") {
    return ["DONE", "DECLINED", "CANCELED"];
  }
  return ["IN_PROGRESS", "DONE", "DECLINED", "CANCELED"];
}

async function searchDocuments(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  opts: {
    statuses: string[];
    keyword: string;
    limit: number;
    maxRetries: number;
    delayMs: number;
  },
): Promise<SearchResponse["documents"]> {
  const results: SearchResponse["documents"] = [];
  let continuationToken: string | undefined;
  let hasMore = true;

  while (hasMore && results.length < opts.limit) {
    const params = new URLSearchParams({
      size: "20",
      sortType: "LAST_UPDATED_AT",
      direction: "DESC",
    });
    if (continuationToken) {
      params.set("continuationToken", continuationToken);
    }

    const page = await withRetry(
      () =>
        flexPost<SearchResponse>(
          authCtx,
          `${baseUrl}/action/v3/approval-document/user-boxes/search?${params.toString()}`,
          {
            filter: {
              statuses: opts.statuses,
              templateKeys: [],
              writerHashedIds: [],
              approverTargets: [],
              referrerTargets: [],
              starred: false,
            },
            search: { keyword: opts.keyword, type: "ALL" },
          },
        ),
      { maxRetries: opts.maxRetries, delayMs: opts.delayMs },
    );

    results.push(...page.documents);
    if (!page.hasNext || results.length >= opts.limit) {
      hasMore = false;
      continue;
    }
    if (!page.continuationToken || page.continuationToken === continuationToken) {
      hasMore = false;
      continue;
    }
    continuationToken = page.continuationToken;
  }

  return results.slice(0, opts.limit);
}

async function fetchDocumentDetail(
  authCtx: Parameters<typeof flexFetch>[0],
  baseUrl: string,
  documentKey: string,
  maxRetries: number,
  delayMs: number,
): Promise<DocumentDetailResponse> {
  return withRetry(
    () => flexFetch<DocumentDetailResponse>(authCtx, `${baseUrl}/api/v3/approval-document/approval-documents/${documentKey}`),
    { maxRetries, delayMs },
  );
}

function toDocumentSummary(row: SearchResponse["documents"][number]): Record<string, unknown> {
  return {
    documentKey: row.document.documentKey,
    code: row.document.code,
    title: row.document.title,
    templateKey: row.document.templateKey,
    status: row.document.status,
    approvalStatus: row.approvalProcess?.status ?? null,
    writer: row.document.writer.name,
    writerId: row.document.writer.idHash,
    writtenAt: row.document.writtenAt,
    updatedAt: row.document.lastUpdatedAt ?? null,
    simpleContent: row.document.simpleContent ?? null,
  };
}

function toDocumentDetail(detail: DocumentDetailResponse): Record<string, unknown> {
  return {
    documentKey: detail.document.documentKey,
    code: detail.document.code,
    templateKey: detail.document.templateKey,
    status: detail.document.status,
    title: detail.document.title,
    writer: detail.document.writer,
    writtenAt: detail.document.writtenAt,
    createdAt: detail.document.createdAt ?? null,
    updatedAt: detail.document.updatedAt ?? null,
    content: detail.document.content ?? null,
    inputs: detail.document.inputs.map((input) => ({
      id: input.idHash,
      fieldId: input.inputField.idHash,
      name: input.inputField.name,
      type: input.inputField.type,
      displayOrder: input.inputField.displayOrder,
      value: input.value,
    })),
    attachments: (detail.document.attachments ?? []).map((attachment) => ({
      id: attachment.idHash,
      fileKey: attachment.file.fileKey,
      fileName: attachment.file.fileName,
      downloadUrl: attachment.file.downloadUrl,
    })),
    approvalProcess: detail.approvalProcess ?? null,
    comments: (detail.document.comments ?? []).map((comment) => ({
      id: comment.idHash,
      writer: comment.writer,
      type: comment.type,
      title: comment.title ?? null,
      content: comment.content ?? null,
      writtenBySystem: comment.writtenBySystem ?? false,
      createdAt: comment.createdAt,
    })),
    raw: detail,
  };
}
