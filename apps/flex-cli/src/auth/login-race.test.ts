import { mock } from "bun:test";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function runRace(mode: string) {
  const email = "login-race@example.com";
  const baseUrl = "https://flex.test";
  const expiresAt = new Date(Date.now() + 12 * 3600_000).toISOString();
  const logger: Logger = { info() {}, warn() {}, error() {}, progress() {} };
  const config = { flexEmail: email, flexBaseUrl: baseUrl } as Config;
  const promptStarted = deferred<void>();
  const code = deferred<string>();
  const refreshStarted = deferred<void>();
  const rejectRefresh = deferred<void>();
  const authorized = deferred<void>();

  // These mocks run only in the child: no real keyring/config writes, TTY input,
  // network calls, or module mocks leaking into the rest of the test suite.
  mock.module("@napi-rs/keyring", () => ({
    Entry: class { deletePassword() { return false; } },
  }));
  mock.module("../config/global-config.js", () => ({
    loadGlobalConfig: () => ({ email }),
    getGlobalConfigPath: () => "unused",
    saveGlobalConfig: () => { throw new Error("unexpected config write"); },
  }));
  mock.module("../auth/credentials.js", () => ({
    promptLine: () => { promptStarted.resolve(); return code.promise; },
  }));

  const { authenticate } = await import("./index.js");
  const { loadSession, saveSession, savePending, loadPending } = await import("./session.js");
  const { runLogin } = await import("../commands/login.js");

  globalThis.fetch = (async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/tokens/workspace/refresh")) {
      refreshStarted.resolve();
      await rejectRefresh.promise;
      return new Response(JSON.stringify({ code: "AUTH_400_000" }), { status: 400 });
    }
    if (path.endsWith("/authorization")) {
      authorized.resolve();
      return Response.json({ v2Response: { workspaceToken: {
        accessToken: { token: "new-access", expireAt: expiresAt },
        refreshToken: { token: "new-refresh", expireAt: expiresAt },
      } } });
    }
    const routes: Record<string, unknown> = {
      "/api-public/v2/auth/challenge": { sessionId: "login-session" },
      "/api-public/v2/auth/verification/identifier": { nextStep: "AUTHENTICATION" },
      "/api-public/v2/auth/authentication/email-otp.issue-code": { expiresAt },
      "/api-public/v2/auth/authentication/email-otp": { nextStep: "AUTHORIZATION" },
    };
    assert.ok(path in routes, `unexpected request: ${path}`);
    return Response.json(routes[path]);
  }) as typeof fetch;

  let login: Promise<unknown>;
  if (mode === "interactive") {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    login = authenticate(config, logger);
    // The interactive login must pass its initial session check before the
    // background process acquires the lock with an expired session.
    await promptStarted.promise;
  }
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  assert.equal(saveSession(email, {
    refreshToken: "expired-refresh", refreshExpireAt: expiresAt, deviceId: "old-device",
  }, logger), true);
  const refreshing = assert.rejects(authenticate(config, logger), /flex-ax login/);
  await refreshStarted.promise;

  if (mode === "interactive") {
    code.resolve("123456");
  } else {
    savePending({ baseUrl, email, deviceId: "new-device", sessionId: "login-session", codeExpiresAt: expiresAt });
    login = runLogin(["--code", "123456"]);
  }
  let loginFinished = false;
  const loggingIn = login!.then(() => { loginFinished = true; });
  await authorized.promise;
  // Drain the authorization/save promise chain while refresh remains blocked.
  // Unlike a timed sleep, this does not race against an HTTP response or clock.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishedBeforeRefresh = loginFinished;
  const sessionBeforeRefresh = loadSession(email)?.session.refreshToken;

  rejectRefresh.resolve();
  await Promise.all([refreshing, loggingIn]);

  assert.equal(loadSession(email)?.session.refreshToken, "new-refresh", "refresh rejection must not delete the new login");
  assert.equal(loadSession(email)?.session.accessToken, "new-access");
  assert.equal(finishedBeforeRefresh, false, "login must wait for the in-flight refresh");
  assert.equal(sessionBeforeRefresh, "expired-refresh", "new login must not save under another run's lock");
  if (mode === "code") assert.equal(loadPending(), null);
}

const mode = process.env.FLEX_LOGIN_RACE_SCENARIO;
if (mode) {
  await runRace(mode);
} else {
  describe("login during an expired session refresh", () => {
    for (const scenario of ["code", "interactive"]) {
      it(`preserves the new session from ${scenario === "code" ? "login --code" : "interactive authenticate"}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "flex-ax-login-race-"));
        try {
          const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            env: {
              ...process.env,
              FLEX_SESSION_FILE: join(dir, "session.json"),
              FLEX_AX_LOG_FILE: join(dir, "flex-ax.log"),
              FLEX_LOGIN_RACE_SCENARIO: scenario,
            },
            encoding: "utf8",
            timeout: 10_000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, 0, result.stdout + result.stderr);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
