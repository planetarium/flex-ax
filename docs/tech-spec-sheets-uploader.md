# 기술 명세서: flex-sheets-uploader

## 1. 개요

### 1.1 목적 및 범위

flex-crawler가 수집한 워크플로우 JSON 데이터(양식 템플릿, 결재 문서 인스턴스, 근태/휴가 승인 이력)를 스프레드시트 형태로 변환하여 Google Sheets에 업로드하는 CLI 앱을 설계한다.

- flex-crawler의 `output/` 디렉토리를 입력으로 받아 JSON 파일을 읽는다
- 7종의 시트(크롤 리포트, 템플릿 목록, 템플릿 필드 정의, 인스턴스 목록, 인스턴스 필드 값, 인스턴스 결재선, 근태/휴가 승인)로 변환한다
- 하나의 Google Sheets 스프레드시트에 업로드한다 (신규 생성 또는 기존 덮어쓰기)
- `apps/flex-sheets-uploader` 디렉토리에 독립 패키지로 구성한다
- monorepo 컨벤션(TypeScript, ESM, pnpm workspace, Turborepo)을 따른다

### 1.2 관련 문서

- 요구 명세서: `docs/req-spec-sheets-uploader.md`
- flex-crawler 기술 명세서: `docs/tech-spec-workflow-crawler.md`

## 2. 기술 스택 및 의존성

### 2.1 기존 스택 (monorepo 기반)

| 항목 | 기술 |
|------|------|
| Language | TypeScript (ES2022 target, ESNext module) |
| Runtime | Node.js >= 20 |
| Package Manager | pnpm 9.x |
| Build Orchestration | Turborepo |
| Module System | ESM (`"type": "module"`) |

### 2.2 신규 의존성

| 패키지 | 용도 | 근거 |
|--------|------|------|
| `googleapis` | Google Sheets API v4 호출 | Google 공식 Node.js 클라이언트. Sheets API의 `spreadsheets.create`, `spreadsheets.batchUpdate`, `spreadsheets.values.batchUpdate` 등 전체 API를 커버하며, 인증(서비스 계정, OAuth)을 내장 지원한다 |
| `zod` | 설정값 및 입력 JSON의 런타임 스키마 검증 | flex-crawler에서 이미 사용 중인 패키지. 외부 소스 데이터의 유효성을 보장한다 |
| `dotenv` | 환경 변수 로딩 | flex-crawler 컨벤션과 동일. 인증 정보 경로 등 설정을 `.env`에서 로딩한다 |
| `tsx` | TypeScript 직접 실행 | flex-crawler 컨벤션과 동일. 빌드 없이 `tsx src/main.ts`로 실행한다 |

### 2.3 의존성 선정 근거

`googleapis`를 선택한 이유:
- Google 공식 라이브러리로서 Sheets API v4의 전체 기능을 지원한다
- `google-auth-library`를 내부적으로 포함하여 서비스 계정 키 파일 인증을 별도 설정 없이 사용할 수 있다
- TBD-001(인증 방식)이 결정되지 않았으나, 서비스 계정과 OAuth 모두 지원하므로 향후 전환이 용이하다

별도의 스프레드시트 변환 라이브러리(xlsx 등)는 도입하지 않는다. Google Sheets API에 직접 2차원 배열 형태로 데이터를 전달하므로 중간 파일 포맷이 불필요하다.

## 3. 아키텍처 설계

### 3.1 전체 구조

flex-crawler와 동일한 **파이프라인 패턴**을 사용하여 단계를 순차 실행한다. 각 단계는 독립 모듈로 분리되며, 공통 인프라(설정, 로깅)를 공유한다.

```
[진입점 main.ts]
    │
    ▼
[1. 설정 로딩] ─── .env, 환경 변수 파싱 및 검증
    │
    ▼
[2. JSON 데이터 읽기] ─── input 경로에서 templates/, instances/, attendance/ JSON 읽기
    │                       + crawl-report.json 읽기
    │
    ▼
[3. 스프레드시트 변환] ─── 7종의 시트 데이터(헤더 + 행)로 변환
    │
    ▼
[4. Google Sheets 인증] ─── 서비스 계정 키 파일로 인증
    │
    ▼
[5. Google Sheets 업로드] ─── 스프레드시트 생성/열기 → 시트 생성 → 데이터 기록
    │
    ▼
[6. 결과 요약 출력] ─── 스프레드시트 URL, 시트별 행 수, 건너뛴 파일 목록
```

### 3.2 데이터 흐름

```
JSON 파일들 (input)
    │
    ▼
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│  reader      │ ──→ │  transformer     │ ──→ │  sheets-client     │
│  (JSON 파싱) │     │  (행 데이터 변환) │     │  (Google Sheets    │
│              │     │                  │     │   API 호출)        │
└─────────────┘     └──────────────────┘     └────────────────────┘
   읽기 결과:            변환 결과:               업로드 결과:
   - templates[]         - SheetData[]           - spreadsheetUrl
   - instances[]         (시트명 + 헤더          - 시트별 행 수
   - attendances[]        + 2차원 배열)
   - crawlReport
   - readErrors[]
```

### 3.3 모듈 레이어 구조

```
src/
├── main.ts                  # 진입점: 파이프라인 오케스트레이션
├── config/                  # 설정 레이어
├── reader/                  # JSON 읽기 레이어
├── transformer/             # 스프레드시트 변환 레이어
├── sheets/                  # Google Sheets API 레이어
├── logger/                  # 로깅 레이어
└── types/                   # 공유 타입 정의
```

의존 방향: `main → reader, transformer, sheets → config, logger, types` (단방향)

### 3.4 flex-crawler와의 관계

flex-sheets-uploader는 flex-crawler에 대한 **런타임 의존성을 갖지 않는다**. flex-crawler의 출력 결과물(JSON 파일)만을 입력으로 사용한다. 따라서:

- flex-crawler의 타입 정의를 직접 import하지 않는다
- 입력 JSON의 구조를 `types/`에 별도로 정의하고 zod 스키마로 검증한다
- flex-crawler의 타입 변경 시 영향을 최소화한다

향후 공유 타입이 필요해지면 `packages/` 하위에 공통 패키지로 추출할 수 있다. 현재 규모에서는 독립 정의가 적합하다.

## 4. 디렉토리 구조

```
apps/flex-sheets-uploader/
├── package.json
├── tsconfig.json
├── .env.example                    # 환경 변수 템플릿 (커밋 대상)
├── .gitignore                      # .env, 인증 키 파일 등
├── src/
│   ├── main.ts                     # 진입점
│   ├── config/
│   │   └── index.ts                # 설정 로딩 및 검증
│   ├── reader/
│   │   └── index.ts                # JSON 파일 읽기 및 유효성 검증
│   ├── transformer/
│   │   ├── index.ts                # 변환 오케스트레이션 (전체 시트 목록 조합)
│   │   ├── templates.ts            # 템플릿 목록 + 필드 정의 시트 변환
│   │   ├── instances.ts            # 인스턴스 목록 + 필드 값 + 결재선 시트 변환
│   │   ├── attendance.ts           # 근태/휴가 승인 시트 변환
│   │   └── report.ts              # 크롤 리포트 시트 변환
│   ├── sheets/
│   │   └── index.ts                # Google Sheets API 인증 및 업로드
│   ├── logger/
│   │   └── index.ts                # 로깅 (콘솔 기반)
│   └── types/
│       ├── input.ts                # 입력 JSON 타입 (flex-crawler output 구조)
│       ├── sheet.ts                # 시트 변환 결과 타입
│       └── common.ts              # 공통 타입 (에러, 결과 요약 등)
└── credentials/                    # Google 인증 키 파일 디렉토리 (gitignore 대상)
```

### 배치 근거

- `apps/` 하위에 독립 패키지로 배치: monorepo의 `pnpm-workspace.yaml` 규칙(`apps/*`) 준수 (FR-018)
- `src/` 디렉토리 사용: `tsconfig.base.json`의 `composite: true` 설정과 일관
- `reader/`: flex-crawler의 `storage/`(저장)에 대응하는 역방향 모듈. 파일 시스템에서 JSON을 읽고 파싱한다
- `transformer/`: 도메인별 변환 로직 분리. flex-crawler의 `crawlers/`가 도메인별 파일로 분리된 패턴을 따른다
- `sheets/`: 외부 서비스(Google Sheets) 통신을 단일 모듈로 격리. flex-crawler의 `auth/`(Playwright)에 대응한다
- `credentials/`: 인증 키 파일의 관례적 디렉토리. `.gitignore`에 포함하여 커밋을 방지한다 (NFR-003, NFR-004)

## 5. 인터페이스 정의

### 5.1 설정 (Config)

```typescript
// src/config/index.ts

interface UploaderConfig {
  /** flex-crawler output 디렉토리 경로 (필수) */
  inputPath: string;
  /** Google 서비스 계정 키 파일 경로 (필수) */
  googleCredentialsPath: string;
  /** 기존 스프레드시트 ID (선택. 미지정 시 새로 생성) */
  spreadsheetId?: string;
  /** 새로 생성할 스프레드시트 이름 (선택. 미지정 시 자동 생성) */
  spreadsheetName?: string;
}

function loadConfig(): UploaderConfig;
```

설정 로딩은 flex-crawler의 `config/index.ts` 패턴을 따른다:
- `dotenv/config`로 `.env` 파일을 로딩한다
- zod 스키마로 환경 변수를 파싱하고 검증한다
- 필수 항목 누락 시 누락된 항목을 명시하는 에러 메시지를 출력한다 (FR-015)

스프레드시트 이름 자동 생성 규칙 (BR-005):
- `spreadsheetId`와 `spreadsheetName`이 모두 미지정인 경우: `flex-workflow-data-YYYY-MM-DD` 형식으로 생성한다

### 5.2 입력 데이터 타입 (Input Types)

```typescript
// src/types/input.ts

/** 양식 필드 정의 */
interface TemplateField {
  name: string;
  type: string;
  required?: boolean;
  options?: string[];
  description?: string;
}

/** 워크플로우 양식(템플릿) - 입력 JSON 구조 */
interface TemplateInput {
  id: string;
  name: string;
  category?: string;
  fields: TemplateField[];
  defaultApprovalLine?: ApprovalStepInput[];
  createdAt?: string;
  updatedAt?: string;
  permissions?: Record<string, unknown>;
  _raw?: unknown;
}

/** 사용자 정보 */
interface UserInfoInput {
  id?: string;
  name: string;
  department?: string;
  position?: string;
}

/** 결재선 단계 */
interface ApprovalStepInput {
  order: number;
  type: string;
  approver: UserInfoInput;
  status: string;
  processedAt?: string;
  comment?: string;
}

/** 첨부파일 정보 */
interface AttachmentInfoInput {
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  localPath?: string;
  downloadError?: string;
}

/** 필드 값 */
interface FieldValueInput {
  fieldName: string;
  fieldType: string;
  value: unknown;
}

/** 워크플로우 인스턴스(결재 문서) - 입력 JSON 구조 */
interface InstanceInput {
  id: string;
  documentNumber?: string;
  templateId: string;
  templateName: string;
  drafter: UserInfoInput;
  draftedAt: string;
  status: string;
  approvalLine: ApprovalStepInput[];
  fields: FieldValueInput[];
  attachments: AttachmentInfoInput[];
  modificationHistory?: Array<{
    modifiedBy: UserInfoInput;
    modifiedAt: string;
    description?: string;
  }>;
  _raw?: unknown;
}

/** 근태/휴가 승인 - 입력 JSON 구조 */
interface AttendanceInput {
  id: string;
  type: string;
  applicant: UserInfoInput;
  appliedAt: string;
  details: Record<string, unknown>;
  status: string;
  approver?: UserInfoInput;
  processedAt?: string;
  _raw?: unknown;
}

/** 수집 결과 */
interface CrawlResultInput {
  totalCount: number;
  successCount: number;
  failureCount: number;
  errors: Array<{
    target: string;
    phase: string;
    message: string;
    timestamp: string;
  }>;
  durationMs: number;
}

/** 크롤 리포트 - 입력 JSON 구조 */
interface CrawlReportInput {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  templates: CrawlResultInput;
  instances: CrawlResultInput;
  attendance: CrawlResultInput;
  totalErrors: Array<{
    target: string;
    phase: string;
    message: string;
    timestamp: string;
  }>;
}
```

### 5.3 시트 변환 결과 타입

```typescript
// src/types/sheet.ts

/** 셀 값 타입 (Google Sheets API에 전달) */
type CellValue = string | number | boolean | null;

/** 단일 시트의 변환 결과 */
interface SheetData {
  /** 시트(탭) 이름 */
  title: string;
  /** 첫 번째 행: 열 이름(헤더) */
  headers: string[];
  /** 두 번째 행부터: 데이터 행 */
  rows: CellValue[][];
}

/** 전체 변환 결과 */
interface TransformResult {
  /** 시트 데이터 목록 (순서대로 업로드) */
  sheets: SheetData[];
}
```

### 5.4 공통 타입

```typescript
// src/types/common.ts

/** JSON 읽기 실패 항목 */
interface ReadError {
  filePath: string;
  reason: string;
}

/** JSON 읽기 결과 */
interface ReadResult {
  templates: TemplateInput[];
  instances: InstanceInput[];
  attendances: AttendanceInput[];
  crawlReport: CrawlReportInput | null;
  errors: ReadError[];
}

/** 업로드 결과 */
interface UploadResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  sheets: Array<{
    title: string;
    rowCount: number;
  }>;
}
```

### 5.5 Reader 인터페이스

```typescript
// src/reader/index.ts

/**
 * 지정된 input 경로에서 flex-crawler output 데이터를 읽는다.
 *
 * - templates/*.json, instances/*.json, attendance/*.json을 각각 읽고 파싱한다
 * - crawl-report.json을 읽는다 (없으면 null)
 * - 파싱 실패 파일은 건너뛰고 errors 배열에 기록한다 (FR-001, NFR-005)
 * - 유효성 검증: zod 스키마로 필수 필드 존재 여부를 확인한다
 */
async function readInputData(
  inputPath: string,
  logger: Logger,
): Promise<ReadResult>;
```

내부적으로 다음을 수행한다:
- `node:fs/promises`의 `readdir`로 디렉토리 내 `*.json` 파일 목록을 수집한다
- 각 파일을 `readFile`로 읽고 `JSON.parse`한다
- zod 스키마로 유효성을 검증한다
  - 템플릿: `id`, `name` 필수
  - 인스턴스: `id`, `templateId`, `templateName`, `drafter`, `draftedAt`, `status` 필수
  - 근태/휴가 승인: `id`, `type`, `applicant`, `appliedAt`, `status` 필수
- 파싱 실패 또는 유효성 실패 파일은 `ReadError`로 기록하고 건너뛴다

### 5.6 Transformer 인터페이스

```typescript
// src/transformer/index.ts

/**
 * ReadResult를 SheetData 배열로 변환한다.
 * BR-001에 따라 7종의 시트를 생성한다.
 */
function transformAll(readResult: ReadResult): TransformResult;
```

```typescript
// src/transformer/report.ts

/** 크롤 리포트 → 시트 변환 (FR-009) */
function transformCrawlReport(report: CrawlReportInput | null): SheetData;
```

```typescript
// src/transformer/templates.ts

/** 템플릿 목록 → 시트 변환 (FR-003) */
function transformTemplateList(templates: TemplateInput[]): SheetData;

/** 템플릿 필드 정의 → 시트 변환 (FR-004) */
function transformTemplateFields(templates: TemplateInput[]): SheetData;
```

```typescript
// src/transformer/instances.ts

/** 인스턴스 목록 → 시트 변환 (FR-005) */
function transformInstanceList(instances: InstanceInput[]): SheetData;

/** 인스턴스 필드 값 → 시트 변환 (FR-006) */
function transformInstanceFields(instances: InstanceInput[]): SheetData;

/** 인스턴스 결재선 → 시트 변환 (FR-007) */
function transformInstanceApprovalLines(instances: InstanceInput[]): SheetData;
```

```typescript
// src/transformer/attendance.ts

/** 근태/휴가 승인 → 시트 변환 (FR-008) */
function transformAttendanceList(attendances: AttendanceInput[]): SheetData;
```

### 5.7 Sheets Client 인터페이스

```typescript
// src/sheets/index.ts

interface SheetsClient {
  /**
   * 새 스프레드시트를 생성하고 데이터를 업로드한다 (FR-011).
   * @param name 스프레드시트 이름
   * @param sheets 업로드할 시트 데이터 배열
   * @returns 업로드 결과 (스프레드시트 URL 포함)
   */
  createAndUpload(name: string, sheets: SheetData[]): Promise<UploadResult>;

  /**
   * 기존 스프레드시트에 데이터를 덮어쓴다 (FR-012).
   * @param spreadsheetId 대상 스프레드시트 ID
   * @param sheets 업로드할 시트 데이터 배열
   * @returns 업로드 결과
   */
  overwriteAndUpload(spreadsheetId: string, sheets: SheetData[]): Promise<UploadResult>;
}

/**
 * Google Sheets API 클라이언트를 생성한다.
 * @param credentialsPath 서비스 계정 키 파일 경로
 */
async function createSheetsClient(
  credentialsPath: string,
  logger: Logger,
): Promise<SheetsClient>;
```

### 5.8 Logger 인터페이스

```typescript
// src/logger/index.ts

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function createLogger(): Logger;
```

flex-crawler의 `Logger` 인터페이스를 간소화한 버전이다. `progress`와 `summary`는 본 앱의 특성(처리 항목이 적음)에 맞게 `info`로 대체한다.

## 6. 상태 관리

### 6.1 상태 구조

flex-crawler와 동일하게, 일회성 파이프라인이므로 **함수 인자와 반환값**으로 상태를 전달한다.

```
UploaderConfig (불변) ──┐
Logger (초기화 후 공유) ──┤──→ reader → transformer → sheets
```

### 6.2 상태 변경 흐름

1. `loadConfig()` → `UploaderConfig` 생성 (이후 불변)
2. `createLogger()` → `Logger` 생성
3. `readInputData(config.inputPath, logger)` → `ReadResult` 생성
4. `transformAll(readResult)` → `TransformResult` 생성
5. `createSheetsClient(config.googleCredentialsPath, logger)` → `SheetsClient` 생성
6. `client.createAndUpload(...)` 또는 `client.overwriteAndUpload(...)` → `UploadResult` 생성
7. 최종 결과 출력

### 6.3 메모리 사용

현재 규모(템플릿 29건, 인스턴스 7건)에서는 전체 데이터를 메모리에 로딩해도 문제가 없다. flex-crawler의 스트리밍 저장 방식과 달리, 본 앱은 **읽기 → 변환 → 업로드** 순서로 전체 데이터를 메모리에 유지한다.

향후 데이터 규모가 크게 증가하면(NFR-002), reader에서 배치 단위로 읽고 transformer/sheets를 반복 호출하는 방식으로 전환할 수 있으나, 현재 설계에서는 고려하지 않는다.

## 7. 에러 처리 전략

### 7.1 에러 분류

| 구분 | 예시 | 처리 방식 |
|------|------|-----------|
| **치명적 에러 (Fatal)** | 설정 누락, 입력 경로 미존재, Google 인증 실패, 네트워크 오류 | 에러 메시지 출력 후 즉시 종료 (`process.exit(1)`) |
| **항목 수준 에러 (Item-level)** | 개별 JSON 파싱 실패, 유효성 검증 실패 | 해당 파일 건너뛰고 나머지 계속 처리. `ReadError`에 기록 (FR-001, NFR-005) |
| **경고 (Warning)** | `crawl-report.json` 미존재, 빈 디렉토리, 근태 데이터 0건 | 경고 메시지 출력 후 계속 진행 |

### 7.2 단계별 에러 처리

**설정 로딩 단계:**
- 필수 환경 변수 누락 → 누락된 항목 명시 후 종료 (FR-015)
- 인증 키 파일 경로가 유효하지 않음 → 경로를 명시하는 에러 메시지 후 종료

**JSON 읽기 단계:**
- 입력 경로가 존재하지 않음 → 에러 메시지와 함께 종료 (FR-001)
- 디렉토리 내 JSON 파일이 0건 → 경고 메시지 출력, 빈 배열 반환 (FR-001)
- 개별 JSON 파싱 실패 → 파일명과 사유를 `ReadError`에 기록, 건너뛰기 (FR-001, NFR-005)
- `crawl-report.json` 미존재 → 경고 메시지 출력, `null` 반환 (FR-002)

**변환 단계:**
- 입력 데이터가 모두 비어 있음 → 헤더만 포함된 시트 생성

**업로드 단계:**
- Google 인증 실패 → 오류 원인 명시 후 종료 (FR-010)
- 스프레드시트 접근 권한 없음 → 스프레드시트 ID와 함께 오류 명시 후 종료 (FR-012)
- 네트워크 오류 → 오류 메시지 출력 후 종료 (FR-010)

### 7.3 결과 요약의 에러 보고

최종 결과 출력 시 건너뛴 파일 목록을 표시한다 (FR-016):
```
건너뛴 파일: 2건
  - templates/abc123.json: Unexpected token at position 42
  - instances/def456.json: 필수 필드 'templateId' 누락
```

## 8. 시트 변환 상세 설계

### 8.1 시트 구성 및 열 정의

#### 시트 1: 크롤 리포트 (FR-009)

시트 이름: `크롤 리포트`

키-값 형태로 구성한다 (일반적인 행 기반 테이블이 아닌 요약 정보):

| 열 A (항목) | 열 B (값) |
|-------------|-----------|
| 수집 시작 시각 | (ISO 8601) |
| 수집 종료 시각 | (ISO 8601) |
| 총 소요 시간(초) | (숫자) |
| 템플릿 - 전체 | (숫자) |
| 템플릿 - 성공 | (숫자) |
| 템플릿 - 실패 | (숫자) |
| 인스턴스 - 전체 | (숫자) |
| 인스턴스 - 성공 | (숫자) |
| 인스턴스 - 실패 | (숫자) |
| 근태/휴가 - 전체 | (숫자) |
| 근태/휴가 - 성공 | (숫자) |
| 근태/휴가 - 실패 | (숫자) |
| 총 오류 건수 | (숫자) |

오류가 존재하면, 빈 행 이후 오류 목록 테이블을 추가한다:

| 대상 | 단계 | 메시지 | 시각 |
|------|------|--------|------|

`crawl-report.json`이 없는 경우, "크롤 리포트 없음" 메시지만 표시한다.

#### 시트 2: 템플릿 목록 (FR-003)

시트 이름: `템플릿 목록`

| 열 | 소스 필드 | 비고 |
|----|-----------|------|
| 템플릿 ID | `id` | |
| 템플릿 이름 | `name` | |
| 카테고리 | `category` | 없으면 빈 문자열 |
| 필드 수 | `fields.length` | 숫자 |
| 생성일 | `createdAt` | ISO 8601. 없으면 빈 문자열 |
| 수정일 | `updatedAt` | ISO 8601. 없으면 빈 문자열 |

#### 시트 3: 템플릿 필드 정의 (FR-004)

시트 이름: `템플릿 필드 정의`

| 열 | 소스 필드 | 비고 |
|----|-----------|------|
| 템플릿 ID | 부모 템플릿의 `id` | |
| 템플릿 이름 | 부모 템플릿의 `name` | |
| 필드 이름 | `fields[n].name` | |
| 필드 유형 | `fields[n].type` | |
| 필수 여부 | `fields[n].required` | `true`/`false`. 미지정 시 빈 문자열 |
| 옵션 목록 | `fields[n].options` | 배열을 쉼표 구분 문자열로 직렬화. 없으면 빈 문자열 |
| 설명 | `fields[n].description` | 없으면 빈 문자열 |

하나의 템플릿이 N개 필드를 가지면 N행이 생성된다.

#### 시트 4: 인스턴스 목록 (FR-005)

시트 이름: `인스턴스 목록`

| 열 | 소스 필드 | 비고 |
|----|-----------|------|
| 인스턴스 ID | `id` | |
| 문서번호 | `documentNumber` | 없으면 빈 문자열 |
| 템플릿 ID | `templateId` | |
| 템플릿 이름 | `templateName` | |
| 기안자 이름 | `drafter.name` | |
| 기안자 부서 | `drafter.department` | 없으면 빈 문자열 |
| 작성일 | `draftedAt` | ISO 8601 |
| 결재 상태 | `status` | |
| 결재선 단계 수 | `approvalLine.length` | 숫자 |
| 첨부파일 수 | `attachments.length` | 숫자 |

#### 시트 5: 인스턴스 필드 값 (FR-006)

시트 이름: `인스턴스 필드 값`

| 열 | 소스 필드 | 비고 |
|----|-----------|------|
| 인스턴스 ID | 부모 인스턴스의 `id` | |
| 문서번호 | 부모 인스턴스의 `documentNumber` | 없으면 빈 문자열 |
| 필드 이름 | `fields[n].fieldName` | |
| 필드 유형 | `fields[n].fieldType` | |
| 필드 값 | `fields[n].value` | 객체/배열은 `JSON.stringify`로 직렬화 (BR-004) |

#### 시트 6: 인스턴스 결재선 (FR-007)

시트 이름: `인스턴스 결재선`

| 열 | 소스 필드 | 비고 |
|----|-----------|------|
| 인스턴스 ID | 부모 인스턴스의 `id` | |
| 문서번호 | 부모 인스턴스의 `documentNumber` | 없으면 빈 문자열 |
| 단계 순서 | `approvalLine[n].order` | 숫자 |
| 승인 유형 | `approvalLine[n].type` | |
| 승인자 이름 | `approvalLine[n].approver.name` | |
| 승인자 부서 | `approvalLine[n].approver.department` | 없으면 빈 문자열 |
| 승인 상태 | `approvalLine[n].status` | |
| 처리 일시 | `approvalLine[n].processedAt` | ISO 8601. 없으면 빈 문자열 |
| 코멘트 | `approvalLine[n].comment` | 없으면 빈 문자열 |

#### 시트 7: 근태/휴가 승인 (FR-008)

시트 이름: `근태/휴가 승인`

| 열 | 소스 필드 | 비고 |
|----|-----------|------|
| 승인 ID | `id` | |
| 유형 | `type` | |
| 신청자 이름 | `applicant.name` | |
| 신청자 부서 | `applicant.department` | 없으면 빈 문자열 |
| 신청일 | `appliedAt` | ISO 8601 |
| 상태 | `status` | |
| 승인자 이름 | `approver.name` | 없으면 빈 문자열 |
| 처리 일시 | `processedAt` | ISO 8601. 없으면 빈 문자열 |
| 상세 정보 | `details` | `JSON.stringify`로 직렬화 (TBD-002) |

데이터가 0건인 경우, 헤더 행만 포함한 시트를 생성한다 (FR-008).

### 8.2 변환 규칙

- **`_raw` 필드 제외 (BR-003)**: 모든 타입의 `_raw` 필드는 변환 대상에서 무시한다. reader에서 JSON을 파싱할 때 `_raw`를 포함하여 읽되, transformer에서 시트 데이터를 생성할 때 `_raw`에 접근하지 않는다.
- **날짜/시각 형식 (BR-002)**: ISO 8601 문자열을 그대로 셀에 기록한다. 별도의 형식 변환은 수행하지 않는다.
- **객체/배열 직렬화 (BR-004)**: `JSON.stringify(value)` 결과를 문자열 셀 값으로 기록한다.
- **선택 필드 부재 시**: 빈 문자열(`""`)을 셀 값으로 사용한다. `null`이나 `undefined`를 전달하지 않는다.

## 9. Google Sheets 업로드 상세 설계

### 9.1 인증

초기 구현은 **서비스 계정(Service Account)** 방식을 사용한다 (TBD-001 결정 전 기본값).

```typescript
// googleapis의 google.auth.GoogleAuth 사용
const auth = new google.auth.GoogleAuth({
  keyFile: credentialsPath,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
```

- 서비스 계정 키 파일(JSON)의 경로를 환경 변수 `GOOGLE_CREDENTIALS_PATH`로 지정한다
- 스코프는 `spreadsheets`만 요청한다 (읽기/쓰기)
- OAuth 방식이 필요해지면 `google.auth.OAuth2` 클래스로 전환할 수 있다

### 9.2 스프레드시트 생성 모드 (FR-011)

1. `sheets.spreadsheets.create`로 새 스프레드시트를 생성한다
   - `properties.title`에 스프레드시트 이름을 설정한다
   - `sheets` 배열에 각 시트의 `properties.title`을 지정한다
2. `sheets.spreadsheets.values.batchUpdate`로 모든 시트 데이터를 한 번에 기록한다
3. 생성된 스프레드시트 URL(`https://docs.google.com/spreadsheets/d/{id}`)을 반환한다

### 9.3 기존 스프레드시트 덮어쓰기 모드 (FR-012)

1. `sheets.spreadsheets.get`으로 스프레드시트 존재 여부 및 접근 권한을 확인한다
2. `sheets.spreadsheets.batchUpdate`로 기존 시트를 삭제하고 새 시트를 생성한다
   - 기본 시트(Sheet1)를 제외한 모든 시트를 삭제한다
   - 새 시트를 추가한다
   - 기본 시트를 삭제한다 (최소 1개 시트가 있어야 하므로 순서가 중요)
3. `sheets.spreadsheets.values.batchUpdate`로 데이터를 기록한다

### 9.4 API 호출 최적화 (NFR-002)

- **배치 쓰기**: 시트별로 개별 API를 호출하지 않고 `batchUpdate`로 모든 시트 데이터를 한 번에 기록한다
- **요청 빈도**: 현재 규모에서는 API 호출이 2~3회(생성 + 데이터 기록)이므로 요청 제한에 도달하지 않는다
- **데이터 규모 증가 시**: Google Sheets API의 요청당 최대 셀 수를 고려하여 배치를 분할하는 로직이 필요할 수 있다 (TBD-005)

## 10. 구현 순서

### Phase 1: 프로젝트 초기화

- `apps/flex-sheets-uploader/package.json` 생성 (workspace 패키지 설정)
- `apps/flex-sheets-uploader/tsconfig.json` 생성 (`tsconfig.base.json` 상속)
- `.env.example` 작성
- `.gitignore` 작성 (`credentials/`, `.env` 등)
- 의존성 설치 (`googleapis`, `zod`, `dotenv`, `tsx`)
- **완료 기준**: `pnpm install` 성공, `pnpm --filter flex-sheets-uploader exec tsx src/main.ts`로 빈 스크립트 실행 가능

### Phase 2: 인프라 레이어 구현

- `src/types/input.ts` 입력 JSON 타입 정의 (zod 스키마 포함)
- `src/types/sheet.ts` 시트 변환 결과 타입 정의
- `src/types/common.ts` 공통 타입 정의
- `src/config/index.ts` 설정 로딩 (zod 스키마 검증)
- `src/logger/index.ts` 로거 구현
- **완료 기준**: 설정 로딩이 동작하고, 환경 변수 누락 시 명확한 에러 메시지를 출력한다

### Phase 3: JSON Reader 구현

- `src/reader/index.ts` 파일 읽기 및 zod 유효성 검증
- 디렉토리 탐색 → JSON 파싱 → 스키마 검증 → 에러 수집
- **완료 기준**: flex-crawler의 output 디렉토리를 입력으로 받아 `ReadResult`를 반환한다. 유효하지 않은 JSON이 포함되어도 나머지를 정상 처리한다

### Phase 4: Transformer 구현

- `src/transformer/report.ts` 크롤 리포트 변환
- `src/transformer/templates.ts` 템플릿 목록 + 필드 정의 변환
- `src/transformer/instances.ts` 인스턴스 목록 + 필드 값 + 결재선 변환
- `src/transformer/attendance.ts` 근태/휴가 승인 변환
- `src/transformer/index.ts` 전체 조합
- **완료 기준**: `ReadResult`를 입력으로 받아 7종의 `SheetData`를 반환한다. 열 구성이 요구사항과 일치한다

### Phase 5: Google Sheets Client 구현

- `src/sheets/index.ts` Google Sheets API 인증 및 업로드
- 스프레드시트 생성 모드 구현
- 기존 스프레드시트 덮어쓰기 모드 구현
- **완료 기준**: 변환된 시트 데이터를 Google Sheets에 업로드하고 URL을 반환한다

### Phase 6: 파이프라인 오케스트레이션

- `src/main.ts` 진입점 구현
- 전체 파이프라인 순차 실행
- 진행 상황 로그 출력 (FR-016)
- 최종 결과 요약 출력 (FR-017)
- **완료 기준**: `pnpm --filter flex-sheets-uploader start`로 전체 파이프라인이 동작하며, Google Sheets URL이 출력된다

## 11. 고려사항 및 제약

### 11.1 성능

- **현재 규모(NFR-001)**: 템플릿 29건 + 인스턴스 7건은 JSON 읽기, 변환, API 호출 모두 수 초 내에 완료된다. 60초 제한에 여유가 충분하다
- **Google Sheets API 제한(NFR-002)**: 현재 API 호출은 2~3회 수준이므로 분당 요청 제한(Google 기본: 분당 60회)에 도달하지 않는다
- **셀 수 제한**: 현재 규모에서 총 셀 수는 수천 이하로, 스프레드시트당 1,000만 셀 제한에 여유가 충분하다

### 11.2 보안

- **인증 키 파일(NFR-003, NFR-004)**: `credentials/` 디렉토리와 `.env` 파일을 `.gitignore`에 포함하여 소스 코드에 인증 정보가 포함되지 않도록 한다
- **루트 `.gitignore`**: 이미 `.env`, `.env.*`가 포함되어 있으나, 앱별 `.gitignore`에도 `credentials/`을 명시적으로 추가한다
- **로그 출력**: 인증 키 파일 경로는 로그에 출력하되, 파일 내용은 출력하지 않는다

### 11.3 미결 사항 대응

| 미결 사항 | 본 설계의 대응 |
|-----------|---------------|
| **TBD-001** (Google 인증 방식) | 서비스 계정 방식을 기본으로 구현한다. `googleapis`의 `GoogleAuth`가 두 방식 모두 지원하므로, OAuth 전환 시 인증 객체 생성 부분만 변경하면 된다 |
| **TBD-002** (근태 details 필드) | `JSON.stringify`로 직렬화하여 단일 열에 표시한다. 실제 데이터 확보 후 열 분리가 필요하면 transformer만 수정한다 |
| **TBD-003** (스프레드시트 공유 설정) | 본 앱에서는 공유 설정을 변경하지 않는다. 서비스 계정으로 생성된 스프레드시트는 기본적으로 서비스 계정만 접근 가능하다. 수동으로 공유를 설정하거나, 향후 필요 시 Drive API 호출을 추가한다 |
| **TBD-004** (첨부파일 경로 표시) | 현재 열 정의에 첨부파일 개수만 포함한다(`attachments.length`). 상세 정보가 필요하면 별도 시트를 추가할 수 있다 |
| **TBD-005** (시트 분할 전략) | 현재 설계에서는 단일 시트를 사용한다. 데이터 규모가 커지면 transformer에 분할 로직을 추가한다 |

### 11.4 향후 확장 가능성

- **새 데이터 유형 추가**: `transformer/`에 새 모듈을 추가하고 `transformAll`에 등록하면 된다
- **다른 스프레드시트 서비스**: `sheets/index.ts`의 `SheetsClient` 인터페이스를 다른 구현체로 교체할 수 있다
- **공유 타입 패키지 추출**: flex-crawler와 입력 JSON 타입이 동일하므로, 향후 `packages/flex-types` 등으로 공통 타입을 추출할 수 있다

### 11.5 package.json 스크립트 컨벤션

```jsonc
// apps/flex-sheets-uploader/package.json scripts
{
  "start": "tsx src/main.ts",
  "build": "tsc --noEmit",    // 타입 체크만 수행 (런타임은 tsx 사용)
  "lint": "tsc --noEmit",
  "clean": "rimraf dist"
}
```

flex-crawler의 스크립트 컨벤션을 따른다. monorepo의 `turbo.json`에 정의된 `build`, `lint`, `clean` 태스크와 호환된다 (FR-019).

### 11.6 .env.example

```bash
# flex-crawler output 디렉토리 경로 (필수)
INPUT_PATH=../flex-crawler/output

# Google 서비스 계정 키 파일 경로 (필수)
GOOGLE_CREDENTIALS_PATH=./credentials/service-account.json

# 기존 스프레드시트 ID (선택. 미지정 시 새 스프레드시트 생성)
# SPREADSHEET_ID=your-spreadsheet-id

# 새로 생성할 스프레드시트 이름 (선택. 미지정 시 flex-workflow-data-YYYY-MM-DD 형식 자동 생성)
# SPREADSHEET_NAME=my-workflow-data
```
