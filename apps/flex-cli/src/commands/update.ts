import { createWriteStream } from "node:fs";
import { rename, rm, mkdir, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const REPO = "planetarium/flex-ax";
const RELEASE_URL = `https://github.com/${REPO}/releases`;

export async function getCurrentVersion(): Promise<string> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(__dirname, "../../package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
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
    await downloadAndInstall(latest);
    console.log(`[FLEX-AX:UPDATE] ${latest} 업데이트 완료!`);
  } catch (err) {
    console.error(
      `[FLEX-AX:ERROR] 업데이트 실패: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}
