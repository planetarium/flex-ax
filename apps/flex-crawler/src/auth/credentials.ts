import { Entry } from "@napi-rs/keyring";
import type { Logger } from "../logger/index.js";

/**
 * flex-cli와 동일한 키링 entry를 공유한다 (service=flex-ax, account=email).
 * 사용자가 한 번 `flex-ax login`을 돌리면 flex-crawler도 그대로 읽어서 쓴다.
 */
const KEYRING_SERVICE = "flex-ax";

export interface Credentials {
  email: string;
  password: string;
  source: "env" | "keyring" | "prompt";
}

export async function resolveCredentials(email: string, logger: Logger): Promise<Credentials> {
  const envPassword = process.env.FLEX_PASSWORD;
  if (envPassword && envPassword.length > 0) {
    return { email, password: envPassword, source: "env" };
  }

  const fromKeyring = readFromKeyring(email);
  if (fromKeyring !== null) {
    logger.info("OS 키링에서 비밀번호 로드");
    return { email, password: fromKeyring, source: "keyring" };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "비밀번호를 찾을 수 없습니다. FLEX_PASSWORD 환경 변수를 설정하거나, " +
        "터미널에서 `flex-ax login`(flex-cli)을 한 번 실행해 OS 키링에 등록해 주세요.",
    );
  }

  const password = await promptPassword(`[FLEX-CRAWLER:AUTH] ${email} 비밀번호: `);
  if (password.length === 0) {
    throw new Error("비밀번호 입력이 비어 있습니다.");
  }
  saveToKeyring(email, password, logger);
  return { email, password, source: "prompt" };
}

export function readFromKeyring(account: string): string | null {
  try {
    const entry = new Entry(KEYRING_SERVICE, account);
    return entry.getPassword();
  } catch {
    return null;
  }
}

export function saveToKeyring(account: string, password: string, logger: Logger): void {
  try {
    const entry = new Entry(KEYRING_SERVICE, account);
    entry.setPassword(password);
    logger.info(`OS 키링에 저장 (service=${KEYRING_SERVICE}, account=${account})`);
  } catch (error) {
    logger.warn("키링 저장 실패 — 이번 실행에만 사용됨", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function deleteFromKeyring(account: string): boolean {
  try {
    const entry = new Entry(KEYRING_SERVICE, account);
    return entry.deletePassword();
  } catch {
    return false;
  }
}

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("TTY가 아니라 비밀번호를 받을 수 없습니다."));
      return;
    }
    process.stdout.write(prompt);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let buffer = "";
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (code === 3) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("입력 취소됨"));
          return;
        }
        if (code === 127 || code === 8) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (code < 32) continue;
        buffer += ch;
      }
    };
    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}
