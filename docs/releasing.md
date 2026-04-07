# Releasing

## flex-cli

태그 푸시로 GitHub Actions 워크플로우(`release-flex-cli.yml`)가 자동 실행된다.

### 절차

1. **main 브랜치에서** `apps/flex-cli/package.json`의 `version` 필드를 업데이트한다.

   ```bash
   # 예: 0.1.0 → 0.2.0
   vi apps/flex-cli/package.json
   git add apps/flex-cli/package.json
   git commit -m "chore: bump flex-cli version to 0.2.0"
   git push origin main
   ```

2. 태그를 생성하고 푸시한다. 태그 이름은 반드시 `flex-cli@<version>` 형식이어야 한다.

   ```bash
   git tag flex-cli@0.2.0
   git push origin flex-cli@0.2.0
   ```

3. GitHub Actions가 빌드 → 버전 검증 → tarball 패킹 → GitHub Release 생성을 자동으로 수행한다.

### 주의사항

- **태그 버전과 package.json 버전이 반드시 일치해야 한다.** 불일치 시 워크플로우가 실패한다.
- 태그는 main 브랜치의 최신 커밋(버전 범프 포함)에서 생성한다.
- Release notes는 GitHub의 auto-generate 기능으로 자동 생성된다.
- 버전 넘버링은 [SemVer](https://semver.org/)를 따른다.
  - patch (`0.1.1`): 버그 수정
  - minor (`0.2.0`): 새 기능 추가 (하위 호환)
  - major (`1.0.0`): 호환 깨지는 변경

### 워크플로우 확인

```bash
# 실행 상태 확인
gh run list --workflow=release-flex-cli.yml --limit 1

# 릴리스 확인
gh release view flex-cli@0.2.0
```
