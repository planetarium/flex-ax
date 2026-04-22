import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export async function runUpdate(): Promise<void> {
  const current = await getCurrentVersion().catch(() => "unknown");
  console.log(`[FLEX-AX:UPDATE] 현재 버전: ${current}`);
  console.log(
    `[FLEX-AX:UPDATE] flex-ax는 standalone 바이너리 배포로 전환됩니다.`,
  );
  console.log(
    `[FLEX-AX:UPDATE] npm 기반 자동 업데이트는 더 이상 지원되지 않습니다.`,
  );
  console.log(
    `[FLEX-AX:UPDATE] 최신 바이너리를 직접 내려받아 주세요:`,
  );
  console.log(`  https://github.com/planetarium/flex-ax/releases/latest`);
}
