import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/index.js";
import type { Logger } from "../logger/index.js";
import { authenticate, HttpError, requestEmailCode, verifyEmailCode } from "./index.js";
import { deletePending, loadPending, loadSession, savePending, saveSession, deleteSession } from "./session.js";

const ORIGINAL_FETCH = globalThis.fetch;
const BASE = "https://flex.test";
const EMAIL = "me@example.com";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function tokens(access: string, refresh: string) {
  return {
    accessToken: { token: access, expireAt: "2026-11-16T16:00:00Z" },
    refreshToken: { token: refresh, expireAt: "2026-11-23T04:00:00Z" },
  };
}

/** path → 응답(JSON 본문 또는 status). 호출 기록을 남긴다. */
function mockFetch(routes: Record<string, unknown | { status: number; body?: unknown }>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    const path = new URL(url).pathname;
    const route = routes[path];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (route && typeof route === "object" && "status" in route) {
      const r = route as { status: number; body?: unknown };
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;
  return calls;
}

function makeConfig(): Config {
  return { flexEmail: EMAIL, flexBaseUrl: BASE } as Config;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flex-ax-auth-"));
  process.env.FLEX_SESSION_FILE = join(dir, "session.json");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.FLEX_SESSION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("session store (FLEX_SESSION_FILE)", () => {
  it("saves per email with 0600 and deletes only that email", () => {
    saveSession(EMAIL, { refreshToken: "r1", refreshExpireAt: "2026-11-23T00:00:00Z", deviceId: "d1" }, silentLogger);
    saveSession("other@example.com", { refreshToken: "r2", refreshExpireAt: "2026-11-23T00:00:00Z", deviceId: "d2" }, silentLogger);

    assert.equal(statSync(process.env.FLEX_SESSION_FILE!).mode & 0o777, 0o600);
    assert.deepEqual(loadSession(EMAIL), {
      session: { refreshToken: "r1", refreshExpireAt: "2026-11-23T00:00:00Z", deviceId: "d1" },
      source: "file",
    });

    assert.equal(deleteSession(EMAIL), true);
    assert.equal(loadSession(EMAIL), null);
    assert.equal(loadSession("other@example.com")?.session.refreshToken, "r2");
    assert.equal(deleteSession(EMAIL), false);
  });

  it("keeps the pending login next to the session file", () => {
    const pending = { baseUrl: BASE, email: EMAIL, deviceId: "d", sessionId: "s", codeExpiresAt: "2026-11-16T05:00:00Z" };
    savePending(pending);
    assert.equal(statSync(join(dir, "pending-login.json")).mode & 0o777, 0o600);
    assert.deepEqual(loadPending(), pending);
    deletePending();
    assert.equal(loadPending(), null);
  });
});

describe("email code login", () => {
  it("requests a code and then exchanges it for workspace tokens on the same session/device", async () => {
    const calls = mockFetch({
      "/api-public/v2/auth/challenge": { sessionId: "sess-1" },
      "/api-public/v2/auth/verification/identifier": { nextStep: "AUTHENTICATION" },
      "/api-public/v2/auth/authentication/email-otp.issue-code": { expiresAt: "2026-11-16T05:00:00Z", maskedEmail: "m*@example.com" },
      "/api-public/v2/auth/authentication/email-otp": { nextStep: "AUTHORIZATION" },
      "/api-public/v2/auth/authorization": { v2Response: { workspaceToken: tokens("acc-1", "ref-1") } },
    });

    const pending = await requestEmailCode(BASE, EMAIL, silentLogger);
    assert.equal(pending.sessionId, "sess-1");
    assert.equal(pending.codeExpiresAt, "2026-11-16T05:00:00Z");

    const result = await verifyEmailCode(pending, " 123456 ", silentLogger);
    assert.equal(result.ctx.workspaceToken, "acc-1");
    assert.equal(result.ctx.refreshToken, "ref-1");
    assert.equal(result.refreshExpireAt, "2026-11-23T04:00:00Z");

    const otp = calls.find((c) => c.url.endsWith("/authentication/email-otp"));
    assert.deepEqual(otp?.body, { code: "123456" });
    for (const c of calls.slice(1)) {
      assert.equal(c.headers["flexteam-v2-login-session-id"], "sess-1");
      assert.equal(c.headers["flexteam-deviceid"], pending.deviceId);
    }
    assert.ok(!calls.some((c) => c.url.includes("/authentication/password")));
  });

  it("refuses accounts that need another step after the code (2FA)", async () => {
    mockFetch({ "/api-public/v2/auth/authentication/email-otp": { nextStep: "TOTP" } });
    const pending = { baseUrl: BASE, email: EMAIL, deviceId: "d", sessionId: "s", codeExpiresAt: "" };
    await assert.rejects(verifyEmailCode(pending, "1", silentLogger), /추가 인증 단계/);
  });

  it("surfaces a wrong code as an HttpError", async () => {
    mockFetch({ "/api-public/v2/auth/authentication/email-otp": { status: 400 } });
    const pending = { baseUrl: BASE, email: EMAIL, deviceId: "d", sessionId: "s", codeExpiresAt: "" };
    await assert.rejects(verifyEmailCode(pending, "000000", silentLogger), HttpError);
  });
});

describe("authenticate", () => {
  it("refreshes the stored session and saves the rotated refresh token", async () => {
    saveSession(EMAIL, { refreshToken: "old-ref", refreshExpireAt: "2026-11-20T00:00:00Z", deviceId: "dev-9" }, silentLogger);
    const calls = mockFetch({ "/api-public/v2/auth/tokens/workspace/refresh": tokens("acc-2", "new-ref") });

    const ctx = await authenticate(makeConfig(), silentLogger);

    assert.equal(ctx.workspaceToken, "acc-2");
    assert.equal(ctx.deviceId, "dev-9");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["flexteam-v2-workspace-refresh"], "old-ref");
    assert.equal(calls[0].headers["flexteam-deviceid"], "dev-9");
    assert.deepEqual(loadSession(EMAIL)?.session, {
      refreshToken: "new-ref",
      refreshExpireAt: "2026-11-23T04:00:00Z",
      deviceId: "dev-9",
      accessToken: "acc-2",
      accessExpireAt: "2026-11-16T16:00:00Z",
    });
  });

  it("reuses a stored access token that still has time left, without refreshing", async () => {
    const later = new Date(Date.now() + 6 * 3600_000).toISOString();
    saveSession(EMAIL, { refreshToken: "ref", refreshExpireAt: later, deviceId: "d", accessToken: "acc-live", accessExpireAt: later }, silentLogger);
    const calls = mockFetch({ "/api-public/v2/auth/tokens/customer-user": [] });

    const ctx = await authenticate(makeConfig(), silentLogger);

    assert.equal(ctx.workspaceToken, "acc-live");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["flexteam-v2-workspace-access"], "acc-live");
    assert.equal(loadSession(EMAIL)?.session.refreshToken, "ref");
  });

  it("does not refresh when checking a live access token fails transiently", async () => {
    const later = new Date(Date.now() + 6 * 3600_000).toISOString();
    for (const status of [429, 500]) {
      saveSession(EMAIL, { refreshToken: "ref", refreshExpireAt: later, deviceId: "d", accessToken: "acc-live", accessExpireAt: later }, silentLogger);
      const calls = mockFetch({
        "/api-public/v2/auth/tokens/customer-user": { status },
        "/api-public/v2/auth/tokens/workspace/refresh": tokens("acc-new", "ref-new"),
      });
      await assert.rejects(authenticate(makeConfig(), silentLogger), HttpError);
      assert.ok(!calls.some((c) => c.url.endsWith("/tokens/workspace/refresh")));
      assert.equal(loadSession(EMAIL)?.session.accessToken, "acc-live");
    }
  });

  it("refreshes when the stored access token is rejected or about to expire", async () => {
    const later = new Date(Date.now() + 6 * 3600_000).toISOString();
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    for (const accessExpireAt of [later, soon]) {
      saveSession(EMAIL, { refreshToken: "ref", refreshExpireAt: later, deviceId: "d", accessToken: "acc-old", accessExpireAt }, silentLogger);
      const calls = mockFetch({
        "/api-public/v2/auth/tokens/customer-user": { status: 401 },
        "/api-public/v2/auth/tokens/workspace/refresh": tokens("acc-new", "ref-new"),
      });
      const ctx = await authenticate(makeConfig(), silentLogger);
      assert.equal(ctx.workspaceToken, "acc-new");
      assert.ok(calls.some((c) => c.url.endsWith("/tokens/workspace/refresh")));
      assert.equal(loadSession(EMAIL)?.session.refreshToken, "ref-new");
    }
  });

  it("drops an expired session and asks for login when not on a TTY", async () => {
    saveSession(EMAIL, { refreshToken: "dead", refreshExpireAt: "2026-11-01T00:00:00Z", deviceId: "d" }, silentLogger);
    mockFetch({ "/api-public/v2/auth/tokens/workspace/refresh": { status: 401 } });

    await assert.rejects(authenticate(makeConfig(), silentLogger), /flex-ax login --request-code/);
    assert.equal(loadSession(EMAIL), null);
  });

  it("drops the session when flex rejects the token with an AUTH_ 400 (live response shape)", async () => {
    saveSession(EMAIL, { refreshToken: "dead", refreshExpireAt: "2026-11-20T00:00:00Z", deviceId: "d" }, silentLogger);
    mockFetch({
      "/api-public/v2/auth/tokens/workspace/refresh": { status: 400, body: { status: 400, code: "AUTH_400_000" } },
    });
    await assert.rejects(authenticate(makeConfig(), silentLogger), /flex-ax login/);
    assert.equal(loadSession(EMAIL), null);
  });

  it("keeps the session on errors that are not a token rejection", async () => {
    saveSession(EMAIL, { refreshToken: "keep", refreshExpireAt: "2026-11-20T00:00:00Z", deviceId: "d" }, silentLogger);
    for (const status of [400, 403, 404, 429, 500]) {
      mockFetch({ "/api-public/v2/auth/tokens/workspace/refresh": { status } });
      await assert.rejects(authenticate(makeConfig(), silentLogger), HttpError);
      assert.equal(loadSession(EMAIL)?.session.refreshToken, "keep");
    }
  });

  it("asks for login when there is no session (non-TTY)", async () => {
    const calls = mockFetch({});
    await assert.rejects(authenticate(makeConfig(), silentLogger), /flex-ax login/);
    assert.equal(calls.length, 0);
  });
});

describe("concurrent runs", () => {
  it("share one access token instead of rotating it out from under each other", async () => {
    saveSession(EMAIL, { refreshToken: "t0", refreshExpireAt: "2026-11-20T00:00:00Z", deviceId: "d" }, silentLogger);
    // flex처럼 갱신마다 토큰을 바꾸고 이전 refresh·access token은 바로 거절하는 가짜 서버
    let refresh = "t0";
    let access = "";
    let n = 0;
    globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const h = init?.headers ?? {};
      await new Promise((r) => setTimeout(r, 20));
      if (String(input).endsWith("/tokens/customer-user")) {
        return h["flexteam-v2-workspace-access"] === access
          ? new Response("[]", { status: 200 })
          : new Response("{}", { status: 401 });
      }
      if (h["flexteam-v2-workspace-refresh"] !== refresh) {
        return new Response(JSON.stringify({ code: "AUTH_400_000" }), { status: 400 });
      }
      n += 1;
      refresh = `t${n}`;
      access = `acc-${n}`;
      const far = new Date(Date.now() + 12 * 3600_000).toISOString();
      return new Response(
        JSON.stringify({ accessToken: { token: access, expireAt: far }, refreshToken: { token: refresh, expireAt: far } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const results = await Promise.all([1, 2, 3].map(() => authenticate(makeConfig(), silentLogger)));

    // 한 번만 갱신하고 셋 다 그 access token을 쓴다 — 셋 모두 아직 유효
    assert.equal(n, 1);
    assert.deepEqual(results.map((c) => c.workspaceToken), ["acc-1", "acc-1", "acc-1"]);
    assert.equal(loadSession(EMAIL)?.session.refreshToken, "t1");
  });
});

describe("logout", () => {
  it("waits for an in-flight refresh so the session is not saved back after logout", async () => {
    saveSession(EMAIL, { refreshToken: "t0", refreshExpireAt: "2026-11-20T00:00:00Z", deviceId: "d" }, silentLogger);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const refreshStarted = new Promise<void>((r) => (started = r));
    globalThis.fetch = (async () => {
      started();
      await gate;
      return new Response(JSON.stringify(tokens("acc-1", "t1")), { status: 200 });
    }) as unknown as typeof fetch;

    const auth = authenticate(makeConfig(), silentLogger);
    await refreshStarted;
    process.env.FLEX_EMAIL = EMAIL;
    const { runLogout } = await import("../commands/logout.js");
    const logout = runLogout([]);
    release();
    await Promise.all([auth, logout]);
    delete process.env.FLEX_EMAIL;

    assert.equal(loadSession(EMAIL), null);
  });
});
