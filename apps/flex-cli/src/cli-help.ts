const TOP_LEVEL_COMMANDS = `Commands:
  login           이메일/비밀번호 등록 (이메일은 ~/.flex-ax/config.json,
                  비밀번호는 OS 키링; 검증 후 저장)
                  비대화식: FLEX_EMAIL/FLEX_PASSWORD env 또는
                  --password-stdin 으로 stdin 파이프 입력 가능
  logout          OS 키링에서 비밀번호 삭제 (글로벌 config의 이메일은 보존)
  status          현재 등록 상태 표시 (비밀번호 값은 마스킹)
  crawl           카탈로그 기반 크롤링 → output/ 저장
  import          크롤링 결과(JSON) → SQLite DB 변환
  query "SQL"     DB 쿼리 실행 → JSON 출력 (read-only)
                  --file <path>  SQL 파일 경로
                  --var key=value  {{key}} 플레이스홀더 치환 (반복 가능)
  live <domain>   flex.team 라이브 조회 진입점
                  attendance | document | people
  attendance <sub>
                  내 휴가/근태 사용 내역 라이브 조회 (별칭)
  document <sub>  결재 문서 라이브 조회 (별칭)
  people <sub>    구성원/부서 라이브 조회 (별칭)
  file <fileKey>  파일 내용 출력 (--info로 메타데이터만)
  workflow <sub>  결재 문서 작성/제출 (templates / describe / submit)
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

Env:
  FLEX_EMAIL                  선택 — 지정 시 글로벌 config보다 우선
                              (평소엔 flex-ax login 으로 한 번만 등록)
  FLEX_PASSWORD               선택 — 지정 시 키링/프롬프트보다 우선
                              (CI에서 사용)
  FLEX_BASE_URL               기본 https://flex.team
  FLEX_CUSTOMERS              크롤 대상 법인 customerIdHash (콤마 구분)
  FLEX_AX_AUTO_UPDATE=false   기동 시 자동 업데이트 비활성화`;

const COMMAND_HELP: Record<string, string> = {
  login: `Usage: flex-ax login [--password-stdin]

이메일/비밀번호를 등록합니다.
--password-stdin 을 사용하면 stdin 파이프로 비밀번호를 주입할 수 있습니다.`,
  logout: `Usage: flex-ax logout

OS 키링에서 저장된 비밀번호를 삭제합니다.`,
  status: `Usage: flex-ax status

현재 등록된 로그인 상태를 표시합니다.`,
  crawl: `Usage: flex-ax crawl

카탈로그 기반으로 데이터를 수집해 output/ 아래에 저장합니다.`,
  import: `Usage: flex-ax import

크롤링 결과(JSON)를 SQLite로 변환합니다.
export 디렉터리가 여러 개면 OUTPUT_DIR=<export-dir> 로 대상을 지정하세요.`,
  query: `Usage: flex-ax query "SELECT ..."
       flex-ax query --file queries/search.sql [--var key=value ...]

SQL을 실행하고 결과를 JSON으로 출력합니다 (read-only).
export 디렉터리가 여러 개면 OUTPUT_DIR=<export-dir> 로 대상을 지정하세요.
스키마는 apps/flex-cli/src/db/schema.sql 을 참조하세요.`,
  live: `Usage: flex-ax live <attendance|document|people> [...]

flex.team 라이브 조회 명령의 공통 진입점입니다.`,
  attendance: `Usage: flex-ax attendance <list|show> [...]

내 휴가/근태 사용 내역을 flex API에서 바로 조회합니다.
권장: flex-ax live attendance ...`,
  document: `Usage: flex-ax document <list|show|attachments> [...]

결재 문서와 첨부파일 메타데이터를 flex API에서 바로 조회합니다.
권장: flex-ax live document ...`,
  people: `Usage: flex-ax people <list|show|departments> [...]

구성원과 부서 정보를 flex API에서 바로 조회합니다.
권장: flex-ax live people ...`,
  file: `Usage: flex-ax file <fileKey> [--info]

수집된 파일 본문을 출력하거나 --info 로 메타데이터만 확인합니다.`,
  workflow: `Usage: flex-ax workflow <templates|describe|submit> [...]

결재 문서 작성/제출 워크플로를 실행합니다.`,
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
