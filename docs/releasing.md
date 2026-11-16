# Releasing flex-cli

## 변경 PR 작성

루트에서 `pnpm install` 후 `pnpm changeset`을 실행하고 **flex-ax**를 선택한다.
실제 패키지는 `apps/flex-cli`이며 루트 package.json도 같은 이름이지만 루트는
Changesets의 workspace 릴리스 대상이 아니다. `flex-sheets-uploader`는 제외한다.

- patch: 버그 수정 및 하위 호환되는 개선.
- minor: 하위 호환되는 기능 추가.
- major: 호환성이 깨지는 변경. 0.x에서도 자동으로 minor로 낮추지 않는다.

생성된 `.changeset/<이름>.md`를 코드와 함께 커밋한다. 요약에는 사용자에게 달라지는
동작을 적고, 호환성 변경이면 기존 동작, 새 동작, 사용자가 해야 할 이전 작업을 적는다.
이 본문은 Release PR의 CHANGELOG와 GitHub Release에 그대로 포함된다.

```markdown
---
"flex-ax": major
---

인증 파일 형식을 변경합니다.

**호환성 변경:** 이전 버전의 세션 파일은 읽을 수 없습니다.
업데이트 후 `flex-ax login`을 다시 실행하세요.
```

문서·테스트·CI만 수정하거나 다른 workspace만 변경하여 CLI 배포가 필요 없다면
`pnpm changeset --empty`로 빈 changeset을 추가하고 PR에 배포가 필요 없는 이유를 적는다.
빈 changeset은 버전을 올리거나 배포하지 않는다. 버전이나 태그를 직접 바꾸지 않는다.
`pnpm changeset status`로 예정된 변경을 확인할 수 있다.

## Release PR 승인과 배포

1. changeset이 main에 머지되면 `Version and release flex-cli`가
   `changeset-release/main` 브랜치의 **chore: release flex-cli** PR을 생성·갱신한다.
2. Release PR에서 `apps/flex-cli/package.json`, `CHANGELOG.md`, 호환성 변경 안내를 검토한다.
3. Release PR을 머지하면 버전이 바뀐 main 커밋을 고정해 세 플랫폼 실행 파일을 빌드한다.
   각 OS에서 `--version`, `status`, import/query smoke test를 통과해야 배포한다.
4. `flex-cli@<version>` 태그를 해당 커밋에 생성하고 draft Release에 세 파일을 올린 뒤 공개한다.
   노트는 해당 버전의 CHANGELOG 항목에서 가져온다.

`privatePackages: { version: true, tag: false }`로 private CLI의 버전·CHANGELOG만
Changesets가 갱신한다. npm publish는 실행하지 않는다. 태그는 별도 스크립트가 기존
접두사 `flex-cli@`로 생성한다. 실행 파일 이름도 유지하여 기존 업데이트 탐색과 호환된다.

- Linux x64: `flex-ax-linux-x64`
- macOS arm64: `flex-ax-darwin-arm64` (ad-hoc 서명 검증 포함)
- Windows x64: `flex-ax-windows-x64.exe`

main 워크플로에서 reusable release/build 워크플로를 직접 호출하므로
`GITHUB_TOKEN`이 생성한 태그 push가 다른 워크플로를 실행할 필요가 없다.
수동 태그 push 진입점도 유지하지만 해당 버전의 CHANGELOG와 패키지 버전이 일치해야 한다.
안정 버전 SemVer만 지원하며 prerelease 배포는 이 흐름에 포함하지 않는다.

## 저장소 설정과 검증

GitHub Settings → Actions → General에서 **Allow GitHub Actions to create and approve
pull requests**를 활성화해야 한다. 저장소/조직 정책이 Actions의 release 브랜치 push,
PR 생성, 태그 및 Release 생성을 허용해야 한다. 별도 PAT나 npm 토큰은 필요 없다.
권한은 빌드 `contents: read`, Release PR 작업 `contents: write` + `pull-requests: write`,
배포 작업 `contents: write`로 제한한다.

기본 `GITHUB_TOKEN`으로 만든 Release PR에는 `pull_request` CI가 자동 실행되지 않을 수 있다.
필수 PR 검사가 대기하면 사람이 PR을 닫았다 다시 열어 검사를 실행한다. 보호 규칙을
우회하지 않는다. 머지 후 배포에서도 세 플랫폼 빌드와 smoke test를 다시 수행한다.

로컬 검증:

```bash
pnpm test:release
pnpm changeset status
# 버전/CHANGELOG 미리보기는 깨끗한 임시 복사본에서 실행한다.
pnpm version-packages
```

## 실패 및 재실행

```bash
gh run list --workflow=changesets.yml --limit 5
gh run view <run-id> --log-failed
gh run rerun <run-id> --failed
gh release view flex-cli@<version>
```

- 빌드 실패: 태그나 Release는 아직 만들지 않는다. 문제를 확인하고 원래 버전 변경
  커밋의 실행을 재시도한다. 소스 수정이 필요하면 수정 PR과 새 changeset으로 다음 버전을 배포한다.
- 태그만 생성된 상태 또는 draft 업로드 실패: 같은 실행을 재시도하면 동일 커밋의 태그를
  재사용하고 draft 파일을 교체한 뒤 공개한다. 모든 job 재실행도 지원한다.
- 이미 공개된 정상 Release: 재시도는 배포를 건너뛰며 파일을 덮어쓰지 않는다.
- 태그가 다른 커밋을 가리키거나 공개된 Release의 파일이 불완전하면 자동 복구하지 않고 실패한다.
  원인을 조사하고 새 버전을 배포한다. 공개 태그 이동이나 실행 파일 덮어쓰기로 복구하지 않는다.
- 네트워크·인증·API 제한 오류는 "릴리스 없음"으로 취급하지 않고 실패한다.
- 이후 일반 커밋은 실패한 이전 버전을 대신 배포하지 않는다. Actions에서 **원래 실행**을
  재실행한다. 워크플로 동시 실행은 취소하지 않고 직렬화하지만 GitHub는 대기 중인 실행을
  교체할 수 있으므로, 빠르게 연속 머지한 Release PR의 실행도 확인한다.

처음 도입 후 Release PR 자동 생성과 실제 공개 배포는 main 머지 후 Actions에서 확인한다.
이 문서나 테스트만으로 외부 GitHub 동작이 완료되었다고 간주하지 않는다.
