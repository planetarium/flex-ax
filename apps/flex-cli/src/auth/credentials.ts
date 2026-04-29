import { Entry } from "@napi-rs/keyring";
import type { Logger } from "../logger/index.js";

/**
 * 키링 entry 식별자.
 * flex-cli와 flex-crawler가 같은 service+account를 공유하도록 통일한다.
 * → 사용자가 `flex-ax login`으로 한 번 등록하면 flex-crawler도 그대로 읽어 쓴다.
 */
const KEYRING_SERVICE = "flex-ax";

export interface Credentials {
  email: string;
  password: string;
  /** 비밀번호를 어디서 얻었는지 — 401 처리 시 키링 무효화 결정에 사용 */
  source: "env" | "keyring" | "prompt";
}

/**
 * 비밀번호를 단계적으로 해석한다.
 *   1. process.env.FLEX_PASSWORD (CI/일회성)
 *   2. OS 키링 (service=flex-ax, account=email)
 *   3. TTY면 대화형 프롬프트 → 키링 저장
 *
 * TTY가 아닌 환경(CI, pipe)에서 1·2 둘 다 비면 명확한 에러로 종료한다.
 */
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
        "터미널에서 `flex-ax login`을 한 번 실행해 OS 키링에 등록해 주세요.",
    );
  }

  const password = await promptPassword(`[FLEX-AX:AUTH] ${email} 비밀번호: `);
  // 사용자가 빈 문자열 그대로 Enter친 경우는 의도된 취소로 본다.
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
    // 키링 백엔드 자체가 사용 불가능한 경우(헤드리스 Linux 등) — 호출자가 폴백 결정
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

/** 화면에 보이는 한 줄 입력 (이메일 등 비-비밀 값용). */
export function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("TTY가 아니라 입력을 받을 수 없습니다."));
      return;
    }
    import("node:readline/promises").then(async ({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(prompt);
        resolve(answer.trim());
      } catch (err) {
        reject(err);
      } finally {
        rl.close();
      }
    });
  });
}

/**
 * TTY에서 비밀번호를 받아오되 입력은 화면에 표시하지 않는다.
 * raw 모드 + 데이터 콜백으로 직접 처리 — 외부 의존 없이 readline만으로는 hide가 어렵다.
 */
export function promptPassword(prompt: string): Promise<string> {
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
          // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          reject(new Error("입력 취소됨"));
          return;
        }
        if (code === 127 || code === 8) {
          // backspace / delete
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (code < 32) continue; // 그 외 제어문자 무시
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
