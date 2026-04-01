# 기술 명세서: flex 워크플로우 데이터 크롤러

## 1. 개요

### 1.1 목적 및 범위

flex(HR SaaS) 서비스의 워크플로우 데이터(양식/템플릿 + 실행 이력/인스턴스 + 근태/휴가 승인)를 수집하여 로컬 파일 시스템에 JSON 형태로 저장하는 일회성 CLI 스크립트를 설계한다.

- 단일 테넌트(회사) 대상, 읽기 전용
- `apps/flex-crawler` 디렉토리에 위치
- monorepo의 기존 컨벤션(TypeScript, ESM, pnpm workspace, Turborepo)을 따름

### 1.2 관련 문서

- 요구 명세서: `docs/req-spec-workflow-crawler.md`

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
| `playwright` | 웹 UI 크롤링 및 내부 API 인터셉트 | flex 전용 워크플로우 Open API가 미확인(OI-001)이므로 웹 크롤링이 주요 수집 수단이 될 가능성이 높음. 브라우저 자동화를 통한 인증(쿠키/세션), 페이지 탐색, 네트워크 요청 인터셉트가 모두 가능 |
| `zod` | 수집 데이터의 런타임 스키마 검증 | 외부 소스에서 수집하는 데이터의 형태를 보장하고, 예상 외 구조 변경을 조기 감지 |
| `dotenv` | 환경 변수 로딩 | 인증 정보 등 민감 정보를 `.env` 파일에서 주입 (FR-003) |
| `tsx` | TypeScript 직접 실행 | 별도 빌드 없이 `tsx src/main.ts`로 스크립트 실행. 일회성 스크립트 특성에 적합 |

### 2.3 선택적 의존성 (Open API 경로 확인 후)

| 패키지 | 용도 | 조건 |
|--------|------|------|
| (별도 HTTP 클라이언트 불필요) | Node.js 20+ 내장 `fetch` 사용 | Open API가 존재하여 REST 호출이 필요한 경우에도 내장 `fetch`로 충분 |

## 3. 아키텍처 설계

### 3.1 전체 구조

스크립트는 **파이프라인 패턴**으로 단계를 순차 실행한다. 각 단계는 독립적인 모듈로 분리되며, 공통 인프라(인증, HTTP, 로깅, 저장)를 공유한다.

```
[진입점 main.ts]
    │
    ▼
[1. 설정 로딩] ─── .env, 환경 변수 파싱 및 검증
    │
    ▼
[2. 인증] ─── Playwright 브라우저 인증 → 세션/쿠키 확보
    │
    ▼
[3. 양식(템플릿) 수집] ─── 양식 목록 조회 → 각 양식 상세 수집
    │
    ▼
[4. 인스턴스(결재 문서) 수집] ─── 인스턴스 목록 조회 → 각 인스턴스 상세 수집
    │                              (페이지네이션, 첨부파일 다운로드 포함)
    │
    ▼
[5. 근태/휴가 승인 수집] ─── 별도 메뉴에서 승인 이력 수집
    │                         (워크플로우와 중복 시 스킵)
    │
    ▼
[6. 저장] ─── 각 단계에서 수집 즉시 파일 저장 (스트리밍 방식)
    │
    ▼
[7. 결과 요약 출력]
```

### 3.2 데이터 접근 전략 (FR-001)

flex 데이터 접근은 **Playwright 기반 하이브리드 접근 방식**을 채택한다.

1. **Playwright 브라우저 인스턴스**로 flex 웹 UI에 로그인
2. **네트워크 요청 인터셉트**를 통해 flex 웹 앱이 내부적으로 호출하는 API endpoint, 요청/응답 구조를 파악
3. 파악된 내부 API를 **직접 호출**(인터셉트된 쿠키/헤더 재사용)하여 데이터 수집
4. 내부 API로 접근할 수 없는 데이터는 **DOM 파싱**으로 수집

이 접근 방식의 이점:
- 인증을 브라우저 수준에서 처리하므로 인증 로직을 별도 구현할 필요가 없음
- 내부 API 구조를 런타임에 발견할 수 있으므로 사전 리버스 엔지니어링 부담이 적음
- Open API가 존재하는 경우에도 동일한 인증 세션으로 호출 가능

### 3.3 모듈 레이어 구조

```
src/
├── main.ts                  # 진입점: 파이프라인 오케스트레이션
├── config/                  # 설정 레이어
├── auth/                    # 인증 레이어
├── crawlers/                # 수집 레이어 (도메인별 크롤러)
├── storage/                 # 저장 레이어
├── logger/                  # 로깅 레이어
└── types/                   # 공유 타입 정의
```

의존 방향: `main → crawlers → auth, storage, logger, types` (단방향)

## 4. 디렉토리 구조

```
apps/flex-crawler/
├── package.json
├── tsconfig.json
├── .env.example              # 환경 변수 템플릿 (커밋 대상)
├── src/
│   ├── main.ts               # 진입점
│   ├── config/
│   │   └── index.ts          # 설정 로딩 및 검증
│   ├── auth/
│   │   └── index.ts          # Playwright 기반 인증
│   ├── crawlers/
│   │   ├── template.ts       # 워크플로우 양식(템플릿) 크롤러
│   │   ├── instance.ts       # 워크플로우 인스턴스(결재 문서) 크롤러
│   │   ├── attendance.ts     # 근태/휴가 승인 크롤러
│   │   └── shared.ts         # 크롤러 공통 유틸 (페이지네이션, 재시도 등)
│   ├── storage/
│   │   └── index.ts          # 파일 시스템 저장
│   ├── logger/
│   │   └── index.ts          # 로깅 (콘솔 + 파일)
│   └── types/
│       ├── template.ts       # 양식 관련 타입
│       ├── instance.ts       # 인스턴스 관련 타입
│       ├── attendance.ts     # 근태/휴가 관련 타입
│       └── common.ts         # 공통 타입 (결재 상태, 사용자 정보 등)
└── output/                   # 수집 데이터 저장 디렉토리 (gitignore 대상)
    ├── templates/            # 양식 JSON 파일
    ├── instances/            # 인스턴스 JSON 파일
    ├── attendance/           # 근태/휴가 승인 JSON 파일
    ├── attachments/          # 첨부파일 원본
    └── crawl-report.json     # 수집 결과 요약
```

### 배치 근거

- `apps/` 하위에 독립 패키지로 배치: monorepo의 `pnpm-workspace.yaml` 규칙(`apps/*`) 준수
- `src/` 디렉토리 사용: `tsconfig.base.json`의 `composite: true` 설정과 일관
- `output/` 디렉토리: 수집 데이터는 코드가 아니므로 소스와 분리. `.gitignore`에 추가

## 5. 인터페이스 정의

### 5.1 설정 (Config)

```typescript
// src/config/index.ts

interface CrawlerConfig {
  /** flex 로그인 이메일 */
  flexEmail: string;
  /** flex 로그인 비밀번호 */
  flexPassword: string;
  /** flex 서비스 베이스 URL (기본값: https://flex.team) */
  flexBaseUrl: string;
  /** 수집 데이터 저장 경로 (기본값: ./output) */
  outputDir: string;
  /** 요청 간 딜레이 (밀리초, 기본값: 1000) */
  requestDelayMs: number;
  /** 요청 실패 시 최대 재시도 횟수 (기본값: 3) */
  maxRetries: number;
  /** 첨부파일 다운로드 여부 (기본값: true) */
  downloadAttachments: boolean;
  /** 브라우저 headless 모드 (기본값: true) */
  headless: boolean;
}

function loadConfig(): CrawlerConfig;
```

### 5.2 인증 (Auth)

```typescript
// src/auth/index.ts

interface AuthContext {
  /** Playwright 브라우저 인스턴스 */
  browser: Browser;
  /** 인증된 브라우저 컨텍스트 (쿠키/세션 포함) */
  context: BrowserContext;
  /** 인증된 페이지 인스턴스 */
  page: Page;
  /** 인터셉트된 인증 헤더/쿠키 (내부 API 직접 호출용) */
  authHeaders: Record<string, string>;
}

/** flex에 로그인하고 인증 컨텍스트를 반환 */
async function authenticate(config: CrawlerConfig): Promise<AuthContext>;

/** 세션 유효성 검증. 만료 시 재인증 시도 */
async function ensureAuthenticated(authCtx: AuthContext, config: CrawlerConfig): Promise<void>;

/** 브라우저 리소스 정리 */
async function cleanup(authCtx: AuthContext): Promise<void>;
```

### 5.3 공통 타입

```typescript
// src/types/common.ts

/** 결재 상태 */
type ApprovalStatus = "pending" | "in_progress" | "approved" | "rejected" | "canceled" | string;

/** 사용자 정보 (기안자, 승인자 등) */
interface UserInfo {
  id?: string;
  name: string;
  department?: string;
  position?: string;
}

/** 결재선 단계 */
interface ApprovalStep {
  order: number;
  type: string;              // 승인, 합의, 참조 등
  approver: UserInfo;
  status: ApprovalStatus;
  processedAt?: string;      // ISO 8601
  comment?: string;
}

/** 첨부파일 정보 */
interface AttachmentInfo {
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  /** output/attachments 내 저장 경로 (다운로드 성공 시) */
  localPath?: string;
  /** 다운로드 실패 시 사유 */
  downloadError?: string;
}

/** 필드 값 */
interface FieldValue {
  fieldName: string;
  fieldType: string;
  value: unknown;
}

/** 수집 실패 항목 */
interface CrawlError {
  target: string;           // 실패한 대상 식별 정보
  phase: string;            // 실패 단계 (list, detail, attachment 등)
  message: string;
  timestamp: string;        // ISO 8601
}
```

### 5.4 양식(템플릿) 타입

```typescript
// src/types/template.ts

/** 양식 필드 정의 */
interface TemplateField {
  name: string;
  type: string;             // text, number, currency, date, select, multiSelect, file 등
  required?: boolean;
  options?: string[];       // select, multiSelect인 경우
  description?: string;
}

/** 워크플로우 양식(템플릿) */
interface WorkflowTemplate {
  id: string;
  name: string;
  category?: string;
  fields: TemplateField[];
  defaultApprovalLine?: ApprovalStep[];
  createdAt?: string;       // ISO 8601
  updatedAt?: string;       // ISO 8601
  permissions?: Record<string, unknown>;
  /** 원본 데이터 (파싱 전 raw 데이터 보존) */
  _raw?: unknown;
}
```

### 5.5 인스턴스 타입

```typescript
// src/types/instance.ts

/** 워크플로우 인스턴스(결재 문서) */
interface WorkflowInstance {
  id: string;
  documentNumber?: string;
  templateId: string;
  templateName: string;
  drafter: UserInfo;
  draftedAt: string;        // ISO 8601
  status: ApprovalStatus;
  approvalLine: ApprovalStep[];
  fields: FieldValue[];
  attachments: AttachmentInfo[];
  modificationHistory?: Array<{
    modifiedBy: UserInfo;
    modifiedAt: string;     // ISO 8601
    description?: string;
  }>;
  /** 원본 데이터 */
  _raw?: unknown;
}
```

### 5.6 근태/휴가 승인 타입

```typescript
// src/types/attendance.ts

/** 근태/휴가 승인 이력 */
interface AttendanceApproval {
  id: string;
  type: string;             // 근무변경, 초과근무, 연차, 법정휴가, 맞춤휴가 등
  applicant: UserInfo;
  appliedAt: string;        // ISO 8601
  details: Record<string, unknown>;  // 대상 날짜, 근무 유형, 휴가 종류 등
  status: ApprovalStatus;
  approver?: UserInfo;
  processedAt?: string;     // ISO 8601
  /** 원본 데이터 */
  _raw?: unknown;
}
```

### 5.7 크롤러 인터페이스

```typescript
// src/crawlers/template.ts
async function crawlTemplates(
  authCtx: AuthContext,
  config: CrawlerConfig,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult>;

// src/crawlers/instance.ts
async function crawlInstances(
  authCtx: AuthContext,
  config: CrawlerConfig,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult>;

// src/crawlers/attendance.ts
async function crawlAttendanceApprovals(
  authCtx: AuthContext,
  config: CrawlerConfig,
  storage: StorageWriter,
  logger: Logger,
): Promise<CrawlResult>;
```

```typescript
// src/crawlers/shared.ts

/** 수집 결과 */
interface CrawlResult {
  totalCount: number;
  successCount: number;
  failureCount: number;
  errors: CrawlError[];
  durationMs: number;
}

/** 페이지네이션 헬퍼 */
async function paginatedFetch<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; hasMore: boolean }>,
  options: { delayMs: number; maxRetries: number; onItem: (item: T) => Promise<void> },
): Promise<void>;

/** 재시도 래퍼 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries: number; delayMs: number; shouldRetry?: (error: unknown) => boolean },
): Promise<T>;

/** 요청 간 딜레이 */
function delay(ms: number): Promise<void>;
```

### 5.8 저장 (Storage)

```typescript
// src/storage/index.ts

interface StorageWriter {
  /** 양식 저장. 파일명: templates/{id}.json */
  saveTemplate(template: WorkflowTemplate): Promise<void>;

  /** 인스턴스 저장. 파일명: instances/{id}.json */
  saveInstance(instance: WorkflowInstance): Promise<void>;

  /** 근태/휴가 승인 저장. 파일명: attendance/{id}.json */
  saveAttendanceApproval(approval: AttendanceApproval): Promise<void>;

  /** 첨부파일 저장. 경로: attachments/{instanceId}/{fileName} */
  saveAttachment(instanceId: string, fileName: string, data: Buffer): Promise<string>;

  /** 수집 결과 요약 저장. 파일명: crawl-report.json */
  saveReport(report: CrawlReport): Promise<void>;
}

interface CrawlReport {
  startedAt: string;          // ISO 8601
  completedAt: string;        // ISO 8601
  durationMs: number;
  templates: CrawlResult;
  instances: CrawlResult;
  attendance: CrawlResult;
  totalErrors: CrawlError[];
}

function createStorageWriter(outputDir: string): StorageWriter;
```

### 5.9 로거 (Logger)

```typescript
// src/logger/index.ts

interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** 진행 상황 표시 (현재 단계, 처리 건수) */
  progress(phase: string, current: number, total?: number): void;
  /** 수집 결과 요약 출력 */
  summary(report: CrawlReport): void;
}

function createLogger(): Logger;
```

Node.js 내장 `console` 기반으로 구현한다. 외부 로깅 라이브러리는 도입하지 않는다. 인증 정보(비밀번호, 토큰)가 로그에 출력되지 않도록 민감 정보 필터링을 포함한다 (NFR-004).

## 6. 상태 관리

### 6.1 상태 구조

이 스크립트는 장기 실행 서비스가 아닌 일회성 파이프라인이므로, 별도의 상태 관리 라이브러리 없이 **함수 인자와 반환값**으로 상태를 전달한다.

```
CrawlerConfig (불변) ──┐
AuthContext (인증 후 생성) ──┤
StorageWriter (초기화 후 공유) ──┤──→ 각 크롤러 함수
Logger (초기화 후 공유) ──┘
```

### 6.2 상태 변경 흐름

1. `loadConfig()` → `CrawlerConfig` 생성 (이후 불변)
2. `authenticate(config)` → `AuthContext` 생성 (세션 만료 시 `ensureAuthenticated`로 갱신)
3. `createStorageWriter(outputDir)` → `StorageWriter` 생성
4. `createLogger()` → `Logger` 생성
5. 각 크롤러는 위 4개를 인자로 받아 `CrawlResult`를 반환
6. 모든 크롤러 완료 후 `CrawlReport`를 조합하여 저장 및 출력

### 6.3 수집 데이터의 즉시 저장 (Streaming Write)

대량 데이터 수집 시 메모리 압박을 방지하기 위해, 각 항목은 수집 즉시 파일로 저장한다. 전체 수집이 완료될 때까지 메모리에 보관하지 않는다.

```
수집 1건 → 검증(zod) → 파일 저장 → 다음 건 수집
```

## 7. 에러 처리 전략

### 7.1 에러 분류

| 구분 | 예시 | 처리 방식 |
|------|------|-----------|
| **치명적 에러 (Fatal)** | 인증 실패, 네트워크 완전 단절, 설정 누락 | 즉시 스크립트 종료. 에러 메시지 출력 |
| **복구 가능 에러 (Recoverable)** | 일시적 네트워크 오류, 타임아웃 | `withRetry`로 재시도 (`maxRetries`회) |
| **항목 수준 에러 (Item-level)** | 특정 양식/인스턴스 접근 실패, 데이터 파싱 실패 | 에러 로그 기록 후 스킵, 나머지 계속 수집 (FR-014) |
| **데이터 누락 (Partial)** | 선택 필드 접근 불가 | 해당 필드를 `undefined`/`null`로 표시, 나머지 정상 수집 |

### 7.2 재시도 정책

- 재시도 대상: HTTP 5xx, 네트워크 타임아웃, 연결 거부
- 재시도 비대상: HTTP 4xx (401 제외), 데이터 파싱 오류
- HTTP 401 발생 시: `ensureAuthenticated`로 세션 재인증 후 재시도
- 재시도 간격: 지수 백오프 (`delayMs * 2^attempt`)
- 최대 재시도: `config.maxRetries` (기본 3)

### 7.3 세션 만료 처리

각 크롤러 내부에서 요청 실패 시 401 응답을 감지하면, `ensureAuthenticated`를 호출하여 세션을 갱신한다. 재인증 실패 시 치명적 에러로 처리한다.

### 7.4 에러 수집 및 보고

모든 항목 수준 에러는 `CrawlError` 형태로 수집되어 `CrawlResult.errors` 배열에 추가되며, 최종적으로 `crawl-report.json`에 포함된다.

## 8. 구현 순서

### Phase 1: 프로젝트 초기화

- `apps/flex-crawler/package.json` 생성 (workspace 패키지 설정)
- `apps/flex-crawler/tsconfig.json` 생성 (`tsconfig.base.json` 상속)
- `.env.example` 작성
- 의존성 설치 (`playwright`, `zod`, `dotenv`, `tsx`)
- `apps/flex-crawler/.gitignore` 작성 (`output/` 추가)
- **완료 기준**: `pnpm install` 성공, `pnpm --filter flex-crawler exec tsx src/main.ts`로 빈 스크립트 실행 가능

### Phase 2: 인프라 레이어 구현

- `src/types/` 전체 타입 정의
- `src/config/index.ts` 설정 로딩 (zod 스키마 검증)
- `src/logger/index.ts` 로거 구현
- `src/storage/index.ts` 파일 저장 구현
- **완료 기준**: 설정 로딩, 로깅, 파일 저장이 독립적으로 동작

### Phase 3: 인증 구현

- `src/auth/index.ts` Playwright 브라우저 인증
- flex 로그인 페이지 탐색 → 이메일/비밀번호 입력 → 인증 완료 대기
- 인증 후 쿠키/헤더 추출
- **완료 기준**: flex에 로그인 성공하고 `AuthContext` 반환

### Phase 4: 크롤러 공통 모듈 구현

- `src/crawlers/shared.ts` 페이지네이션, 재시도, 딜레이 유틸
- **완료 기준**: `paginatedFetch`, `withRetry` 함수가 동작

### Phase 5: 양식(템플릿) 크롤러 구현

- `src/crawlers/template.ts`
- flex 웹 UI에서 양식 목록 페이지 탐색
- 내부 API 인터셉트 또는 DOM 파싱으로 양식 목록 수집
- 각 양식 상세 페이지 탐색 → 필드 정의, 결재선 등 수집
- **완료 기준**: 모든 접근 가능한 양식이 `output/templates/` 에 JSON으로 저장

### Phase 6: 인스턴스(결재 문서) 크롤러 구현

- `src/crawlers/instance.ts`
- 인스턴스 목록 페이지네이션 수집
- 각 인스턴스 상세 수집 (필드 값, 결재선, 코멘트)
- 첨부파일 다운로드 (설정에 따라)
- **완료 기준**: 인스턴스와 첨부파일이 `output/instances/`, `output/attachments/`에 저장

### Phase 7: 근태/휴가 승인 크롤러 구현

- `src/crawlers/attendance.ts`
- 워크플로우와 중복 여부 판별 로직 (BR-004)
- **완료 기준**: 근태/휴가 승인 이력이 `output/attendance/`에 저장. 중복 데이터 없음

### Phase 8: 파이프라인 오케스트레이션

- `src/main.ts` 진입점 구현
- 전체 파이프라인 순차 실행
- 결과 요약 출력 및 `crawl-report.json` 저장
- **완료 기준**: `pnpm --filter flex-crawler start`로 전체 수집 파이프라인이 동작

## 9. 고려사항 및 제약

### 9.1 성능

- **요청 간격**: `requestDelayMs` (기본 1000ms)로 flex 서비스 부하 방지 (NFR-001). 필요 시 조정 가능
- **메모리**: 수집 데이터를 즉시 파일로 저장하여 메모리 사용량을 항목 1건 분량으로 제한
- **브라우저 리소스**: Playwright headless 모드로 리소스 사용 최소화. 이미지/폰트/미디어 로딩 비활성화 가능

### 9.2 보안

- 인증 정보는 `.env` 파일에서만 로딩 (FR-003). `.env`는 `.gitignore`에 포함되어 커밋 방지
- 로그에 비밀번호, 토큰, 쿠키 값 출력 금지 (NFR-004). 로거에서 민감 키워드 필터링
- 수집된 데이터의 접근 관리는 실행자 책임 (NFR-003). `output/` 디렉토리의 파일 권한 관련 안내를 실행 완료 시 표시

### 9.3 데이터 무결성

- 각 수집 항목에 `_raw` 필드로 원본 데이터를 보존하여, 파싱 로직에 오류가 있더라도 원본 데이터 손실 방지
- zod 스키마 검증 실패 시 항목 수준 에러로 처리하되, `_raw` 데이터는 저장하여 수동 확인 가능

### 9.4 flex UI 변경 취약성 (C-002)

- 일회성 스크립트이므로 장기 유지보수는 고려하지 않음
- 다만 DOM 셀렉터를 상수로 분리하여 변경 시 한 곳만 수정하도록 구조화
- 가능한 한 내부 API 직접 호출을 우선하여 UI 변경에 대한 의존도를 최소화

### 9.5 중복 수집 방지 (BR-004)

- 근태/휴가 승인 크롤러(`attendance.ts`)는 수집 전에 이미 인스턴스 크롤러에서 동일 데이터가 수집되었는지 확인
- 판별 기준: 신청 식별자 기반 매칭. 워크플로우 인스턴스와 근태/휴가 승인이 동일한 ID 체계를 공유하는 경우 스킵
- 판별이 불확실한 경우, 양쪽 모두 수집하되 `crawl-report.json`에 잠재적 중복 항목을 별도 표시

### 9.6 향후 확장 가능성

- 타입 정의와 크롤러 인터페이스가 분리되어 있으므로, 새로운 데이터 유형 추가 시 크롤러 모듈만 추가하면 됨
- `StorageWriter` 인터페이스를 교체하면 DB 저장 등 다른 저장소로 전환 가능
- 스케줄링이 필요해지면 `main.ts`를 래핑하는 스케줄러를 별도 구현 가능

### 9.7 package.json 스크립트 컨벤션

```jsonc
// apps/flex-crawler/package.json scripts
{
  "start": "tsx src/main.ts",
  "build": "tsc --noEmit",  // 타입 체크만 수행 (런타임은 tsx 사용)
  "lint": "tsc --noEmit",
  "clean": "rimraf output dist"
}
```

monorepo의 `turbo.json`에 정의된 `build`, `lint`, `clean` 태스크와 호환되도록 스크립트를 구성한다.
