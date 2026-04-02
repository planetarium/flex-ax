# /flex-crawl

Flex 데이터 크롤링을 실행하고, 실패 시 원인을 분석하여 코드를 수정한다.

## Trigger

- 사용자가 `/flex-crawl` 입력
- "크롤러 실행", "flex 데이터 수집" 등 요청

## Workflow

1. `cd apps/flex-cli && AUTH_MODE=sso pnpm crawl` 실행
   - CLI 출력에 `[FLEX-AX:AUTH] 브라우저에서 로그인을 완료해 주세요` 가 나오면 사용자에게 안내: "브라우저가 열렸습니다. flex.team에 로그인해 주세요."
   - 타임아웃(5분) 시 사용자에게 재시도 요청
2. 성공 시:
   - `[FLEX-AX:CRAWL]` 출력에서 수집 결과 요약
   - `output/` 디렉토리의 파일 수 확인
3. 실패 시 (exit code 2 또는 에러):
   a. `[FLEX-AX:ERROR]` 출력에서 실패한 엔드포인트와 에러 메시지 파싱
   b. `output/api-catalog.json` 읽기 (있으면)
   c. 에러 유형별 대응:
      - **404 / URL 변경**: `/flex-discover` 실행하여 카탈로그 갱신 → URL 업데이트
      - **응답 파싱 에러**: 카탈로그의 `responseBodySample`과 크롤러의 타입/매핑 코드 비교 → 수정
      - **401 / 인증 만료**: 사용자에게 재로그인 요청
      - **500 / 서버 에러**: 사용자에게 보고, 재시도 제안
   d. 코드 수정 후 `tsc --noEmit`으로 타입 체크
   e. `pnpm crawl`로 재실행하여 수정 검증

## Key Files

- `apps/flex-cli/src/crawlers/template.ts` — 양식 크롤러
- `apps/flex-cli/src/crawlers/instance.ts` — 인스턴스 크롤러
- `apps/flex-cli/src/crawlers/attendance.ts` — 근태/휴가 크롤러
- `apps/flex-cli/src/crawlers/shared.ts` — 공유 유틸 (flexFetch, resolveUrl)
- `apps/flex-cli/output/api-catalog.json` — API 카탈로그
- `apps/flex-cli/output/crawl-report.json` — 크롤 리포트
