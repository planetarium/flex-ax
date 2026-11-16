import { describe, it, afterAll, mock } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger/index.js";

// Linux 백엔드 생성 실패처럼 Entry 생성자 자체가 던지는 키링
mock.module("@napi-rs/keyring", () => ({
  Entry: class {
    constructor() {
      throw new Error("no keyring backend");
    }
  },
}));

// 기본 세션 파일(~/.flex-ax/session.json)이 실제 홈에 생기지 않게 import 전에 HOME을 임시 폴더로
const home = mkdtempSync(join(tmpdir(), "flex-ax-keyring-"));
const prevHome = process.env.HOME;
process.env.HOME = home;
delete process.env.FLEX_SESSION_FILE;
const { loadSession, saveSession } = await import("./session.js");

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

afterAll(() => {
  process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("session store when the keyring constructor throws", () => {
  it("falls back to the session file instead of losing the rotated token", () => {
    const saved = saveSession("me@example.com", { refreshToken: "r", refreshExpireAt: "x", deviceId: "d" }, silentLogger);

    assert.equal(saved, true);
    assert.ok(existsSync(join(home, ".flex-ax", "session.json")));
    assert.deepEqual(loadSession("me@example.com"), {
      session: { refreshToken: "r", refreshExpireAt: "x", deviceId: "d" },
      source: "file",
    });
  });
});
