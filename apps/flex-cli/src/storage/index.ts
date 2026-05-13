import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrawlError } from "../types/common.js";
import type { AttendanceApproval } from "../types/attendance.js";
import type { WorkflowInstance } from "../types/instance.js";
import type { WorkflowTemplate } from "../types/template.js";
import type { ApiCatalog } from "../types/catalog.js";
import { type CrawlResult, toKstDate } from "../crawlers/shared.js";

/**
 * customer 단위 증분 수집 워터마크. 도메인(예: `approvalDocuments`)별로
 * 그룹별 마지막 관측 `updatedAt` UTC ISO 문자열을 저장한다.
 *
 * 그룹별로 따로 두는 이유는 IN_PROGRESS와 DONE 그룹이 변동 패턴과 권장
 * overlap이 다르기 때문이다. `lastFullReconAt`은 도메인 공통이다.
 */
export interface WatermarkGroupState {
  lastUpdatedAt: string;
  /**
   * 다음 실행 시 검색 from 날짜를 워터마크보다 N일 앞당긴다. flex의 date-단위 필터 잘림 보정용.
   * Optional — 누락 시 호출자가 group 단위 default를 사용한다.
   */
  overlapDays?: number;
  /**
   * 마지막으로 이 그룹이 성공적으로 수집된 시각 (정보용). Optional — 사용자가
   * watermark.json을 손으로 편집할 때 이 필드를 빠뜨려도 워터마크 자체는 살린다.
   */
  lastSuccessfulRunAt?: string;
}

/** overlapDays로 받아들일 수 있는 정수 상한. 그 이상은 손상으로 간주해 default fallback. */
const MAX_OVERLAP_DAYS = 365;

export interface WatermarkDomainState {
  groups: Record<string, WatermarkGroupState>;
  lastFullReconAt?: string;
  /**
   * 직전 성공 run이 사용한 검색 스코프. approval-documents 도메인 한정 — 다른
   * 도메인은 이 필드를 사용하지 않는다.
   *
   * 다음 run에서 결정된 스코프와 비교해, 다르거나 비어 있으면 그 run을
   * effectiveFull로 강제한다. 핵심 사용 케이스 두 가지:
   *   1. user-boxes 시절 워터마크를 가진 환경이 customer-boxes로 업그레이드된
   *      직후: 디스크에 이 필드가 없음 → 첫 run 자동 full → 백필.
   *      운영자가 `--mode=full`을 까먹어도 같은 결과.
   *   2. 관리자 권한이 회수/부여되어 스코프가 user↔customer로 바뀌는 경우도
   *      같은 메커니즘으로 자가복구.
   */
  lastCrawledBoxScope?: "customer" | "user";
}

export interface WatermarkFile {
  [domain: string]: WatermarkDomainState | undefined;
}

export interface CrawlReport {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  templates: CrawlResult;
  instances: CrawlResult;
  attendance: CrawlResult;
  catalogEndpoints?: CrawlResult;
  /**
   * Full reconciliation diff. 풀크롤(또는 부트스트랩)에서 디스크에는 있었지만
   * 이번 실행 검색 목록에서 사라진 docKey들. 권한 회수/문서 삭제/flex list
   * 누락 등의 신호. 자동 tombstone은 별도 트랙. incremental 실행에선 비워둔다.
   */
  instancesMissing?: string[];
  /**
   * 이번 실행이 사용한 결재 문서 검색 스코프.
   *  - "customer": `/customer-boxes/search` — 워크스페이스 전체.
   *  - "user":     `/user-boxes/search`     — 로그인 계정 관여 문서만.
   * "user"로 떨어지면 관리자 권한 부재로 모집단이 좁아진 상태이므로 운영자는
   * `totalErrors`에서 `instance-scope` 항목을 함께 확인해야 한다.
   * 인스턴스 단계가 시작 전에 실패하면 미정의일 수 있다.
   */
  instancesBoxScope?: "customer" | "user";
  totalErrors: CrawlError[];
}

export interface StorageWriter {
  saveTemplate(template: WorkflowTemplate): Promise<void>;
  saveInstance(instance: WorkflowInstance): Promise<void>;
  saveAttendanceApproval(approval: AttendanceApproval): Promise<void>;
  saveAttachment(instanceId: string, fileName: string, data: Buffer, fileKey?: string): Promise<string>;
  saveEndpointData(endpointId: string, data: unknown): Promise<void>;
  saveReport(report: CrawlReport): Promise<void>;
  saveCatalog(catalog: ApiCatalog): Promise<void>;
  loadWatermarks(): Promise<WatermarkFile>;
  saveWatermarks(file: WatermarkFile): Promise<void>;
  /**
   * `${outputDir}/instances/` 안에 이미 저장된 docKey 집합을 반환한다.
   * 디렉토리가 없으면 빈 set. full reconciliation diff 계산에 쓰인다.
   */
  listExistingInstanceKeys(): Promise<Set<string>>;
  /**
   * 저장된 단일 인스턴스 JSON을 읽는다. 없거나 파싱 실패면 null.
   * closed-window sweep이 status / lastUpdatedAt 메타만 보기 위해 사용한다.
   */
  readInstance(id: string): Promise<WorkflowInstance | null>;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `JSON.parse`는 `__proto__`/`constructor`/`prototype` 같은 특수 키를 own
 * property로 만들 수 있다. 검증 없이 일반 `{}`에 대입하면 프로토타입이
 * 오염되거나 객체 동작이 비정상화될 수 있으므로 이 키들은 거른다.
 */
function isSafeKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * 손상되거나 사람이 손댄 watermark.json을 안전한 shape으로 정규화한다.
 * 의도적으로 관대하다(스키마 위반은 조용히 누락) — 워터마크는 손실되어도
 * 부트스트랩 풀크롤로 자가복구되므로 크롤 전체를 중단시키는 것보다 낫다.
 *
 * `now`는 미래 시각 워터마크 감지용으로만 쓰이며 호출자가 명시적으로 주입할
 * 수 있다 (테스트 결정론). 미래 워터마크는 손편집/클록스큐 신호로 보고
 * 그 그룹을 drop해, 다음 실행이 풀크롤로 자가복구되게 한다.
 */
export function normalizeWatermarkFile(
  parsed: unknown,
  now: number = Date.now(),
): WatermarkFile {
  if (!isPlainObject(parsed)) return {};
  const todayKst = toKstDate(now);
  const out: WatermarkFile = {};
  for (const [domain, rawState] of Object.entries(parsed)) {
    if (!isSafeKey(domain)) continue;
    if (!isPlainObject(rawState)) continue;
    const groupsCandidate = (rawState as Record<string, unknown>).groups;
    const groups: Record<string, WatermarkGroupState> = {};
    if (isPlainObject(groupsCandidate)) {
      for (const [label, rawGroup] of Object.entries(groupsCandidate)) {
        if (!isSafeKey(label)) continue;
        if (!isPlainObject(rawGroup)) continue;
        const lastUpdatedAt = rawGroup.lastUpdatedAt;
        // lastUpdatedAt만이 워터마크의 본질. 나머지는 누락/이상값이면 omit해서
        // 호출자가 default로 폴백하게 한다 (=그룹 자체를 잃지 않는다).
        // 빈 문자열/공백은 영구적으로 unusable하므로 그룹째 드롭한다.
        if (typeof lastUpdatedAt !== "string" || lastUpdatedAt.trim().length === 0) {
          continue;
        }
        // 미래 timestamp는 손상 신호. 그대로 두면 computeDateRange가 from>to인
        // 잘못된 범위를 만들어 검색이 빈 결과/에러를 반환할 수 있고, 후퇴 금지
        // 정책 때문에 자가복구도 막힌다. 그러나 비교 기준을 epoch ms로 두면
        // 운영 환경의 NTP skew(수초~수분) 만으로도 정상 워터마크가 미래 판정을
        // 받아 매 실행 부트스트랩으로 폴백할 수 있어, 여기선 KST date 기준으로
        // 비교한다 — 같은 날이면 통과, 그 다음날 이후로 명확히 미래일 때만
        // 그룹째 drop해 다음 실행을 풀크롤로 자가복구하게 한다. 파싱 불가
        // 값(NaN)은 통과시키고 computeDateRange의 finite 가드가 처리한다.
        const ms = Date.parse(lastUpdatedAt);
        if (Number.isFinite(ms) && toKstDate(ms) > todayKst) continue;
        const group: WatermarkGroupState = { lastUpdatedAt };
        const overlapDays = rawGroup.overlapDays;
        if (
          typeof overlapDays === "number" &&
          Number.isInteger(overlapDays) &&
          overlapDays >= 0 &&
          overlapDays <= MAX_OVERLAP_DAYS
        ) {
          group.overlapDays = overlapDays;
        }
        const lastSuccessfulRunAt = rawGroup.lastSuccessfulRunAt;
        if (typeof lastSuccessfulRunAt === "string") {
          group.lastSuccessfulRunAt = lastSuccessfulRunAt;
        }
        groups[label] = group;
      }
    }
    const lastFullReconAt = (rawState as Record<string, unknown>).lastFullReconAt;
    const lastCrawledBoxScope = (rawState as Record<string, unknown>).lastCrawledBoxScope;
    out[domain] = {
      groups,
      lastFullReconAt: typeof lastFullReconAt === "string" ? lastFullReconAt : undefined,
      // "customer"/"user" 외 값은 손상으로 간주하고 undefined로 처리한다.
      // undefined가 되면 다음 run에서 scope mismatch가 일어나 자동으로 full
      // recon이 트리거되므로, 손상된 필드는 자가복구된다.
      lastCrawledBoxScope:
        lastCrawledBoxScope === "customer" || lastCrawledBoxScope === "user"
          ? lastCrawledBoxScope
          : undefined,
    };
  }
  return out;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function createStorageWriter(outputDir: string, catalogPath: string): StorageWriter {
  return {
    async saveTemplate(template) {
      const safeId = path.basename(template.id);
      await writeJson(path.join(outputDir, "templates", `${safeId}.json`), template);
    },

    async saveInstance(instance) {
      const safeId = path.basename(instance.id);
      await writeJson(path.join(outputDir, "instances", `${safeId}.json`), instance);
    },

    async saveAttendanceApproval(approval) {
      const safeId = path.basename(approval.id);
      await writeJson(path.join(outputDir, "attendance", `${safeId}.json`), approval);
    },

    async saveAttachment(instanceId, fileName, data, fileKey) {
      const safeInstanceId = path.basename(instanceId);
      const dir = path.join(outputDir, "attachments", safeInstanceId);
      await ensureDir(dir);
      const baseName = path.basename(fileName).replace(/[<>:"|?*]/g, "_") || "attachment";
      // fileKey가 있으면 prefix로 추가하여 동일 파일명 충돌 방지
      const safeName = fileKey ? `${path.basename(fileKey)}_${baseName}` : baseName;
      const filePath = path.join(dir, safeName);
      await writeFile(filePath, data);
      return filePath;
    },

    async saveEndpointData(endpointId, data) {
      const safeId = path.basename(endpointId).replace(/[<>:"|?*]/g, "_");
      await writeJson(path.join(outputDir, "endpoints", `${safeId}.json`), data);
    },

    async saveReport(report) {
      await writeJson(path.join(outputDir, "crawl-report.json"), report);
    },

    async saveCatalog(catalog) {
      await writeJson(catalogPath, catalog);
    },

    async loadWatermarks() {
      const watermarkPath = path.join(outputDir, "watermark.json");
      let content: string;
      try {
        content = await readFile(watermarkPath, "utf-8");
      } catch (err) {
        // 파일 없음(ENOENT) — 정상적인 부트스트랩 시나리오. silent fallback.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
        // 권한/디스크/디렉토리 충돌 등 기타 I/O 에러는 surface해서 호출자가
        // 인지하게 한다. 침묵 부트스트랩은 이전에 잘 채워둔 워터마크를
        // 모르고 덮어쓰는 위험이 있다.
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // 손상된 JSON은 부트스트랩으로 폴백. 다음 정상 실행에서 새로 채워진다.
        return {};
      }
      return normalizeWatermarkFile(parsed);
    },

    async saveWatermarks(file) {
      await writeJson(path.join(outputDir, "watermark.json"), file);
    },

    async readInstance(id) {
      const safeId = path.basename(id);
      const filePath = path.join(outputDir, "instances", `${safeId}.json`);
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const obj = parsed as Record<string, unknown>;
      // 필수 필드 검증 — 누락/타입 불일치면 type-cast로 거짓말하지 말고 null
      // 반환. 호출자(closed-window sweep 등)는 이미 null을 정상 처리한다.
      if (typeof obj.id !== "string" || obj.id.length === 0) return null;
      if (typeof obj.status !== "string") return null;
      // 정규화 — instance JSON이 디스크에 쓰일 당시 schema에 없던 필드는
      // undefined로 들어오는데, 캐스트만 하면 type system은 이를 모르고
      // downstream의 null 비교가 어긋난다. 누락 필드를 명시적인 기본값으로
      // 채워 옛 파일도 새 shape에 맞게 읽히도록 한다.
      if (obj.signatureHash === undefined) obj.signatureHash = null;
      if (obj.lastUpdatedAt === undefined) {
        // PR #51 이전 인스턴스 JSON엔 top-level lastUpdatedAt이 없지만
        // `_raw.document.updatedAt`은 보존되어 있다. 이걸 채우지 않으면
        // closed-window sweep이 옛 데이터에 한해선 영영 후보를 못 만든다.
        // import.ts도 같은 폴백 패턴(data.lastUpdatedAt ?? doc.updatedAt)을 쓴다.
        const raw = obj._raw as { document?: { updatedAt?: unknown } } | undefined;
        const rawUpdatedAt = raw?.document?.updatedAt;
        obj.lastUpdatedAt = typeof rawUpdatedAt === "string" ? rawUpdatedAt : null;
      }
      if (!Array.isArray(obj.attachments)) obj.attachments = [];
      if (!Array.isArray(obj.fields)) obj.fields = [];
      if (!Array.isArray(obj.approvalLine)) obj.approvalLine = [];
      return obj as unknown as WorkflowInstance;
    },

    async listExistingInstanceKeys() {
      const dir = path.join(outputDir, "instances");
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
        throw err;
      }
      const keys = new Set<string>();
      for (const entry of entries) {
        // 디렉토리 / 비-json 엔트리 제외. `foo.json/`처럼 디렉토리가 .json
        // 확장자를 가져도 docKey로 오인되지 않도록.
        if (!entry.isFile()) continue;
        const name = entry.name;
        if (!name.endsWith(".json")) continue;
        keys.add(name.slice(0, -".json".length));
      }
      return keys;
    },
  };
}
