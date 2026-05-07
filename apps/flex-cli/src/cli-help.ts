const TOP_LEVEL_COMMANDS = `Commands:
  login           이메일/비밀번호 등록 (이메일은 ~/.flex-ax/config.json,
                  비밀번호는 OS 키링; 검증 후 저장)
                  비대화식: FLEX_EMAIL/FLEX_PASSWORD env 또는
                  --password-stdin 으로 stdin 파이프 입력 가능
                  --gui 로 플랫폼 기본 대화상자 사용 가능
  logout          OS 키링에서 비밀번호 삭제 (글로벌 config의 이메일은 보존)
                  --gui 로 삭제 확인 대화상자 사용 가능
  status          현재 등록 상태 표시 (비밀번호 값은 마스킹)
  crawl           카탈로그 기반 크롤링 → output/ 저장
  import          크롤링 결과(JSON) → SQLite DB 변환
  query "SQL"     DB 쿼리 실행 → JSON 출력 (read-only)
                  --file <path>  SQL 파일 경로
                  --var key=value  {{key}} 플레이스홀더 치환 (반복 가능)
  live <domain>   flex.team 원격 명령 진입점
                  attendance | document | people | workflow
  attendance <sub>
                  내 휴가/근무 기록 라이브 조회 (별칭)
  document <sub>  문서 명령 (legacy: 결재 문서 조회는 workflow 사용 권장)
  people <sub>    구성원/부서 라이브 조회 (별칭)
  file <fileKey>  파일 내용 출력 (--info로 메타데이터만)
  workflow <sub>  결재 문서 조회/작성/제출
  check-apis      하드코딩된 API 엔드포인트 상태 확인
  install-skills  에이전트 스킬을 .claude/skills/에 설치
  update          최신 버전으로 업데이트`;

const TOP_LEVEL_NOTES = `Workflow:
  login -> status -> crawl -> import -> query

Multi-export query:
  OUTPUT_DIR=<export-dir> flex-ax query "SELECT 1 AS x"
  export 디렉터리가 여러 개면 OUTPUT_DIR로 사용할 대상 하나를 명시해야 합니다.

Options:
  --version, -v       버전 출력
  --help, -h          도움말 출력
  --password-stdin    (login 전용) 비밀번호를 stdin 파이프로 주입
  --gui               (login/logout 전용) 플랫폼 기본 대화상자 사용

Env:
  FLEX_EMAIL                  선택 — 지정 시 글로벌 config보다 우선
                              (평소엔 flex-ax login 으로 한 번만 등록)
  FLEX_PASSWORD               선택 — 지정 시 키링/프롬프트보다 우선
                              (CI에서 사용)
  FLEX_BASE_URL               기본 https://flex.team
  FLEX_CUSTOMERS              크롤 대상 법인 customerIdHash (콤마 구분)
  FLEX_CRAWL_MODE             incremental(기본) | full
                              full 은 결재 문서 워터마크를 무시하고 전체 재수집
  FLEX_CLOSED_SWEEP_DAYS=30   종결(DONE/DECLINED/CANCELED) 후 N일 이내 문서를
                              매 cycle 추가로 detail 재조회 (댓글 흡수). 0이면 비활성
  FLEX_AX_AUTO_UPDATE=false   기동 시 자동 업데이트 비활성화`;

const COMMAND_HELP: Record<string, string> = {
  login: `Usage: flex-ax login [--gui] [--password-stdin]

이메일/비밀번호를 등록합니다.
--gui 를 사용하면 브라우저 대신 플랫폼 기본 대화상자로 입력합니다.
--password-stdin 을 사용하면 stdin 파이프로 비밀번호를 주입할 수 있습니다.`,
  logout: `Usage: flex-ax logout [--gui]

OS 키링에서 저장된 비밀번호를 삭제합니다.
--gui 를 사용하면 삭제 확인 대화상자를 표시합니다.`,
  status: `Usage: flex-ax status

현재 등록된 로그인 상태를 표시합니다.`,
  crawl: `Usage: flex-ax crawl [--full]

카탈로그 기반으로 데이터를 수집해 output/ 아래에 저장합니다.

결재 문서 인스턴스는 기본적으로 증분 수집(incremental)으로 동작합니다.
customer 단위로 output/<customerIdHash>/watermark.json 을 두고, 다음 실행
시 flex 검색 요청에 lastUpdatedDateRange (KST 기준)을 적용합니다. 워터마크가
없는 첫 실행은 자동으로 부트스트랩 풀크롤로 폴백합니다.

진행 중(IN_PROGRESS) 문서는 워터마크와 무관하게 매 cycle 전체 sweep합니다 —
flex의 document.updatedAt이 댓글 mutation으로는 갱신되지 않기 때문에
워터마크 검색만으론 댓글 변화를 흡수할 수 없습니다. 종결(DONE/DECLINED/
CANCELED) 문서 중 종결된 지 N일 이내인 것도 같은 이유로 매 cycle 추가
재조회합니다 (FLEX_CLOSED_SWEEP_DAYS, 기본 30, 0이면 비활성).

Options:
  --full          워터마크 무시, 결재 문서 전체 재수집 (env: FLEX_CRAWL_MODE=full)`,
  import: `Usage: flex-ax import

크롤링 결과(JSON)를 SQLite로 변환합니다.
export 디렉터리가 여러 개면 OUTPUT_DIR=<export-dir> 로 대상을 지정하세요.`,
  query: `Usage: flex-ax query "SELECT ..."
       flex-ax query --file queries/search.sql [--var key=value ...]

SQL을 실행하고 결과를 JSON으로 출력합니다 (read-only).
export 디렉터리가 여러 개면 OUTPUT_DIR=<export-dir> 로 대상을 지정하세요.
스키마는 apps/flex-cli/src/db/schema.sql 을 참조하세요.`,
  live: `Usage: flex-ax live <attendance|document|people|workflow> [...]

flex.team 원격 조회/실행 명령의 공통 진입점입니다.`,
  attendance: `Usage: flex-ax attendance <list|show|work-records|balances|policies> [...]

내 휴가/근무 기록을 flex API에서 바로 조회합니다.
권장: flex-ax live attendance ...`,
  document: `Usage: flex-ax document <list|show|attachments> [...]

Deprecated: 결재 문서 조회는 workflow list/show/attachments/status 를 사용하세요.
문서·증명서 메뉴용 회사 문서/증명서 명령은 별도 서브커맨드로 추가될 예정입니다.`,
  people: `Usage: flex-ax people <list|show|departments> [...]

구성원과 부서 정보를 flex API에서 바로 조회합니다.
권장: flex-ax live people ...`,
  file: `Usage: flex-ax file <fileKey> [--info]

수집된 파일 본문을 출력하거나 --info 로 메타데이터만 확인합니다.`,
  workflow: `Usage: flex-ax workflow <templates|describe|submit|list|show|status|attachments> [...]

결재 문서 조회/작성/제출 워크플로를 실행합니다.
권장: flex-ax live workflow ...`,
  "check-apis": `Usage: flex-ax check-apis

하드코딩된 API 엔드포인트 상태를 점검합니다.`,
  "install-skills": `Usage: flex-ax install-skills

에이전트 스킬을 설치합니다.`,
  update: `Usage: flex-ax update

최신 버전으로 업데이트합니다.`,
};

export function isHelpFlag(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h";
}

export function getTopLevelHelp(): string {
  return `Usage: flex-ax <command>

${TOP_LEVEL_COMMANDS}

${TOP_LEVEL_NOTES}`;
}

export function getCommandHelp(command: string): string | null {
  return COMMAND_HELP[command] ?? null;
}
