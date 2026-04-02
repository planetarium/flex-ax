# /flex-discover

Flex API 디스커버리를 실행하고 카탈로그를 분석한다.

## Trigger

- 사용자가 `/flex-discover` 입력
- "flex API 변경사항 확인", "새 워크플로우 발견" 등 요청

## Workflow

1. `cd apps/flex-cli && AUTH_MODE=sso pnpm discover` 실행
   - CLI 출력에 `[FLEX-AX:AUTH] 브라우저에서 로그인을 완료해 주세요` 가 나오면 사용자에게 안내: "브라우저가 열렸습니다. flex.team에 로그인해 주세요."
   - 타임아웃(5분) 시 사용자에게 재시도 요청
2. CLI 완료 후 `output/api-catalog.json` 읽기
3. 결과 분석:
   - `entries`: 알려진 엔드포인트 목록과 URL 패턴 확인
   - `unclassified`: 새로 발견된 미분류 API 목록 확인
   - 이전 카탈로그와 차이가 있으면 변경사항 리포트
4. 액션 제안:
   - URL 변경 → `discovery/catalog.ts`의 `ENDPOINT_PATTERNS` 업데이트
   - 응답 스키마 변경 → `responseBodySample`을 참고해 크롤러 매핑 코드 수정
   - 새 API 발견 → 새 크롤러 모듈 작성 제안
5. 변경사항이 있으면 코드 수정 후 `tsc --noEmit`으로 타입 체크

## Key Files

- `apps/flex-cli/src/discovery/catalog.ts` — ENDPOINT_PATTERNS 매핑
- `apps/flex-cli/src/crawlers/` — 크롤러 모듈들
- `apps/flex-cli/output/api-catalog.json` — 생성된 카탈로그
