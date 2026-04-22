// bun compile 단일 바이너리에서 실행 중이면 모든 소스 모듈의 import.meta.url이
// file:///$bunfs/root/... 형태가 된다. dev(bun src/cli.ts)나 npm 배포 모드에서는
// 실제 파일 경로가 그대로 노출되므로 이 한 가지 지문으로 충분히 구분된다.
export function isStandaloneBinary(): boolean {
  return import.meta.url.includes("/$bunfs/");
}
