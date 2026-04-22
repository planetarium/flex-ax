import { createWriteStream } from "node:fs";
import { chmod, rename, rm, mkdir, stat } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import pkg from "../../package.json" with { type: "json" };
import { isStandaloneBinary } from "../runtime.js";

const REPO = "planetarium/flex-ax";
// 기본값은 퍼블릭 GitHub. 테스트/사내 미러 대응을 위해 env로 base URL 교체 가능.
const RELEASE_URL = process.env.FLEX_AX_RELEASE_URL || `https://github.com/${REPO}/releases`;

export async function getCurrentVersion(): Promise<string> {
  return pkg.version;
}

export async function getLatestVersion(signal?: AbortSignal): Promise<string> {
  // GitHub redirects /releases/latest to /releases/tag/<tag>
  const res = await fetch(`${RELEASE_URL}/latest`, { redirect: "manual", signal });
  const location = res.headers.get("location");
  if (!location) {
    throw new Error("최신 릴리스를 찾을 수 없습니다.");
  }
  // location: https://github.com/planetarium/flex-ax/releases/tag/flex-cli@0.2.0
  const tag = location.split("/").pop()!;
  const version = tag.replace("flex-cli@", "");
  return version;
}

function platformSlug(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  if (p === "darwin" && a === "x64") return "darwin-x64";
  if (p === "linux" && a === "x64") return "linux-x64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  throw new Error(
    `자동 업데이트를 지원하지 않는 플랫폼(${p}-${a})입니다. 수동으로 다운로드해 주세요.`,
  );
}

// POSIX 환경에서는 실행 중인 바이너리 경로에 직접 rename을 해도 기존 프로세스의
// 오픈 FD는 원본 inode를 참조한 상태로 유지된다. 같은 디렉토리에 임시파일을
// 먼저 내려받고 chmod → rename 순으로 처리하면 atomic 교체가 된다. rename이
// 실패하면 임시파일만 삭제하므로 현재 실행 파일은 오염되지 않는다.
export async function downloadBinaryAndReplace(version: string): Promise<void> {
  const slug = platformSlug();
  const assetName = `flex-ax-${slug}`;
  const downloadUrl = `${RELEASE_URL}/download/flex-cli@${version}/${assetName}`;

  console.log(`[FLEX-AX:UPDATE] 다운로드 중: ${downloadUrl}`);
  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) {
    throw new Error(
      `다운로드 실패 (${res.status} ${res.statusText}): ${assetName}이 릴리스에 없거나 접근 불가`,
    );
  }

  const currentPath = process.execPath;
  const tmpPath = `${currentPath}.new-${process.pid}`;

  try {
    const fileStream = createWriteStream(tmpPath);
    // @ts-expect-error ReadableStream to NodeJS stream
    await pipeline(res.body, fileStream);

    // HTML 에러 페이지나 리다이렉트 본문을 바이너리로 오인해 덮어쓰는 것을 막는다.
    // 실제 바이너리는 수십 MB이므로 1MB 미만은 전부 오류로 처리한다.
    const { size } = await stat(tmpPath);
    if (size < 1_000_000) {
      throw new Error(
        `다운로드된 바이너리가 너무 작습니다 (${size} bytes). 릴리스 에셋이 정상 업로드되었는지 확인하세요.`,
      );
    }

    await chmod(tmpPath, 0o755);
    await rename(tmpPath, currentPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function downloadAndInstall(version: string): Promise<void> {
  const tgzName = `flex-ax-${version}.tgz`;
  const downloadUrl = `${RELEASE_URL}/download/flex-cli@${version}/${tgzName}`;

  console.log(`[FLEX-AX:UPDATE] 다운로드 중: ${downloadUrl}`);
  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) {
    throw new Error(`다운로드 실패: ${res.status} ${res.statusText}`);
  }

  // npm pack tarball 구조: package/ 아래에 파일이 들어있음
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(__dirname, "../..");
  const tmpDir = path.join(packageRoot, ".update-tmp");

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const tgzPath = path.join(tmpDir, tgzName);

  // 다운로드
  const fileStream = createWriteStream(tgzPath);
  // @ts-expect-error ReadableStream to NodeJS stream
  await pipeline(res.body, fileStream);

  // 압축 해제
  console.log("[FLEX-AX:UPDATE] 압축 해제 중...");
  execSync(`tar -xzf ${JSON.stringify(tgzPath)} -C ${JSON.stringify(tmpDir)}`);

  // package/ 내용물을 패키지 루트로 복사
  const extractedDir = path.join(tmpDir, "package");

  // dist/ 교체
  const distTarget = path.join(packageRoot, "dist");
  await rm(distTarget, { recursive: true, force: true });
  await rename(path.join(extractedDir, "dist"), distTarget);

  // package.json 교체
  await rename(
    path.join(extractedDir, "package.json"),
    path.join(packageRoot, "package.json"),
  );

  // 정리
  await rm(tmpDir, { recursive: true, force: true });
}

export async function runUpdate(): Promise<void> {
  try {
    const current = await getCurrentVersion();
    console.log(`[FLEX-AX:UPDATE] 현재 버전: ${current}`);

    const latest = await getLatestVersion();
    console.log(`[FLEX-AX:UPDATE] 최신 버전: ${latest}`);

    if (current === latest) {
      console.log("[FLEX-AX:UPDATE] 이미 최신 버전입니다.");
      return;
    }

    console.log(`[FLEX-AX:UPDATE] ${current} → ${latest} 업데이트 시작`);
    if (isStandaloneBinary()) {
      await downloadBinaryAndReplace(latest);
    } else {
      await downloadAndInstall(latest);
    }
    console.log(`[FLEX-AX:UPDATE] ${latest} 업데이트 완료!`);
  } catch (err) {
    console.error(
      `[FLEX-AX:ERROR] 업데이트 실패: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
