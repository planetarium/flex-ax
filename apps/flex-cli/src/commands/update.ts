import { copyFile, createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { FLEX_AX_VERSION } from "../version.js";

const REPO = "planetarium/flex-ax";
const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases`;
const HELPER_COMMAND = "__self-update-helper";
const UPDATE_DIR = path.join(homedir(), ".flex-ax", "updates");

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

interface PreparedUpdate {
  currentVersion: string;
  latestVersion: string;
  assetName: string;
  downloadPath: string;
}

interface InstallOptions {
  relaunchArgs?: string[];
}

interface HelperPayload {
  parentPid: number;
  targetPath: string;
  downloadPath: string;
  helperPath: string;
  relaunchArgs?: string[];
}

export async function getCurrentVersion(): Promise<string> {
  return FLEX_AX_VERSION;
}

export async function getLatestVersion(signal?: AbortSignal): Promise<string> {
  const release = await getLatestRelease(signal);
  return versionFromTag(release.tag_name);
}

export async function downloadAndInstall(
  version: string,
  options: InstallOptions = {},
): Promise<void> {
  const standaloneExecutable = getStandaloneExecutablePath();
  const release = await getLatestRelease();
  const latestVersion = versionFromTag(release.tag_name);
  if (latestVersion !== version) {
    throw new Error(`latest release moved from ${version} to ${latestVersion}; try again`);
  }

  const asset = selectAssetForCurrentPlatform(release.assets);
  const downloadPath = await downloadReleaseAsset(release.tag_name, asset);
  await verifyReleaseAsset(downloadPath, asset);

  await handOffToHelper(standaloneExecutable, downloadPath, options);
}

export async function runUpdate(): Promise<void> {
  try {
    const current = await getCurrentVersion();
    console.log(`[FLEX-AX:UPDATE] current version: ${current}`);

    const latest = await getLatestVersion();
    console.log(`[FLEX-AX:UPDATE] latest version: ${latest}`);

    if (current === latest) {
      console.log("[FLEX-AX:UPDATE] already up to date");
      return;
    }

    if (!isStandaloneExecutableRun()) {
      throw new Error(
        "self-update is only supported from the standalone Bun executable release",
      );
    }

    console.log(`[FLEX-AX:UPDATE] starting update ${current} -> ${latest}`);
    await downloadAndInstall(latest);
  } catch (err) {
    console.error(
      `[FLEX-AX:ERROR] update failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

export async function runSelfUpdateHelper(argv: string[] = process.argv.slice(3)): Promise<void> {
  try {
    const payload = parseHelperPayload(argv);
    await waitForProcessExit(payload.parentPid, 60_000);
    await replaceExecutable(payload);

    if (payload.relaunchArgs && payload.relaunchArgs.length > 0) {
      const child = spawn(payload.targetPath, payload.relaunchArgs, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    await cleanupAfterSuccess(payload);
  } catch (err) {
    console.error(
      `[FLEX-AX:ERROR] self-update helper failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

export function isStandaloneExecutableRun(): boolean {
  const executable = path.basename(process.execPath).toLowerCase();
  return executable !== "node" && executable !== "node.exe" && executable !== "bun" && executable !== "bun.exe";
}

function getStandaloneExecutablePath(): string {
  if (!isStandaloneExecutableRun()) {
    throw new Error("not running from a standalone executable");
  }
  return process.execPath;
}

async function getLatestRelease(signal?: AbortSignal): Promise<ReleaseInfo> {
  const res = await fetch(`${RELEASES_API_URL}/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "flex-ax",
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`failed to fetch latest release: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ReleaseInfo;
}

function versionFromTag(tag: string): string {
  return tag.replace(/^flex-cli@/, "");
}

function expectedAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") return "flex-ax-windows-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "flex-ax-darwin-arm64";
  if (platform === "linux" && arch === "x64") return "flex-ax-linux-x64";

  throw new Error(`unsupported self-update target: ${platform}-${arch}`);
}

function selectAssetForCurrentPlatform(assets: ReleaseAsset[]): ReleaseAsset {
  const assetName = expectedAssetName();
  const asset = assets.find((candidate) => candidate.name === assetName);
  if (!asset) {
    throw new Error(`latest release is missing asset ${assetName}`);
  }
  return asset;
}

async function downloadReleaseAsset(tag: string, asset: ReleaseAsset): Promise<string> {
  const version = versionFromTag(tag);
  await mkdir(UPDATE_DIR, { recursive: true });
  const downloadPath = path.join(UPDATE_DIR, `${version}-${asset.name}.download`);

  console.log(`[FLEX-AX:UPDATE] downloading ${asset.browser_download_url}`);
  const res = await fetch(asset.browser_download_url, {
    headers: { "user-agent": "flex-ax" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: ${res.status} ${res.statusText}`);
  }

  const fileStream = createWriteStream(downloadPath);
  // @ts-expect-error ReadableStream to NodeJS stream
  await pipeline(res.body, fileStream);
  return downloadPath;
}

async function verifyReleaseAsset(downloadPath: string, asset: ReleaseAsset): Promise<void> {
  if (!asset.digest) {
    console.warn("[FLEX-AX:UPDATE] asset digest missing; skipping integrity verification");
    return;
  }

  const [algorithm, expectedHash] = asset.digest.split(":", 2);
  if (algorithm !== "sha256" || !expectedHash) {
    throw new Error(`unsupported asset digest: ${asset.digest}`);
  }

  const actualHash = await sha256File(downloadPath);
  if (actualHash !== expectedHash) {
    throw new Error(`asset digest mismatch for ${asset.name}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function handOffToHelper(
  targetPath: string,
  downloadPath: string,
  options: InstallOptions,
): Promise<void> {
  const helperPath = await prepareHelperExecutable(targetPath);
  const payload: HelperPayload = {
    parentPid: process.pid,
    targetPath,
    downloadPath,
    helperPath,
    relaunchArgs: options.relaunchArgs,
  };

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const child = spawn(helperPath, [HELPER_COMMAND, encoded], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  console.log("[FLEX-AX:UPDATE] update staged; exiting so the helper can replace the executable");
  process.exit(0);
}

async function prepareHelperExecutable(targetPath: string): Promise<string> {
  await mkdir(UPDATE_DIR, { recursive: true });

  const helperName = process.platform === "win32"
    ? `${path.parse(targetPath).name}-update-helper.exe`
    : `${path.basename(targetPath)}-update-helper`;
  const helperPath = path.join(UPDATE_DIR, helperName);

  await rm(helperPath, { force: true }).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    copyFile(targetPath, helperPath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return helperPath;
}

function parseHelperPayload(args: string[]): HelperPayload {
  const encoded = args[0];
  if (!encoded) {
    throw new Error("missing helper payload");
  }

  const raw = Buffer.from(encoded, "base64").toString("utf8");
  return JSON.parse(raw) as HelperPayload;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function replaceExecutable(payload: HelperPayload): Promise<void> {
  const backupPath = `${payload.targetPath}.old`;

  await rm(backupPath, { force: true }).catch(() => {});
  if (existsSync(payload.targetPath)) {
    await retryAsync(() => rename(payload.targetPath, backupPath));
  }

  try {
    await retryAsync(() => rename(payload.downloadPath, payload.targetPath));
  } catch (error) {
    if (existsSync(backupPath)) {
      await retryAsync(() => rename(backupPath, payload.targetPath)).catch(() => {});
    }
    throw error;
  }

  if (process.platform !== "win32") {
    await chmod(payload.targetPath, 0o755);
  }
  await ensureExecutableExists(payload.targetPath);
  await rm(backupPath, { force: true }).catch(() => {});
}

async function ensureExecutableExists(filePath: string): Promise<void> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size === 0) {
    throw new Error(`replacement executable is invalid: ${filePath}`);
  }
}

async function cleanupAfterSuccess(payload: HelperPayload): Promise<void> {
  await rm(payload.downloadPath, { force: true }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryAsync<T>(
  operation: () => Promise<T>,
  attempts = 20,
  delayMs = 250,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;
      await sleep(delayMs);
    }
  }
  throw lastError;
}
