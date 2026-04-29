import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import {
  authenticate,
  cleanup,
  listCorporations,
  apiHeaders,
} from "../auth/index.js";

// 실제 time-off-uses 조회 URL에는 userId와 from..to 범위가 필요하다.
// check-apis는 라이트하게 엔드포인트 존재 여부만 확인하므로,
// userId 자리에 "me"를 쓰면 route 매칭에 실패한다. 사용자 ID를 먼저 조회한 뒤
// 실제 URL 형식을 그대로 사용한다.
const APIS_TO_CHECK = [
  { label: "template-list", method: "GET", path: "/api/v3/approval-document-template/templates" },
  { label: "instance-search", method: "POST", path: "/action/v3/approval-document/user-boxes/search" },
  { label: "core-me", method: "GET", path: "/api/v2/core/me" },
  { label: "user-me-workspace", method: "GET", path: "/api/v2/core/users/me/workspace-users-corp-group-affiliates" },
  { label: "time-off-uses (old: 404)", method: "GET", path: "/api/v2/time-off/users/me/time-off-requests" },
  {
    label: "time-off-uses (new, by-use-date-range)",
    method: "GET",
    path: "/api/v2/time-off/users/{userId}/time-off-uses/by-use-date-range/{from}..{to}",
  },
];

export async function runCheckApis(): Promise<void> {
  const logger = createLogger("CHECK");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const authCtx = await authenticate(config, logger);

  try {
    console.log("\n  API 엔드포인트 상태 확인\n");
    console.log("  " + "-".repeat(56));

    // listCorporations는 내부적으로 첫 법인으로 bootstrap exchange를 수행하므로
    // 호출 후에는 customerToken이 채워진 상태가 된다. 이로써 후속 /api/ 호출이 가능해진다.
    let userId = "";
    try {
      const corps = await listCorporations(authCtx, config.flexBaseUrl);
      userId = corps[0]?.userIdHash ?? "";
    } catch (error) {
      logger.warn("법인/유저 조회 실패 — userId placeholder는 SKIPPED 처리", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const substitute = (path: string): string =>
      path
        .replace("{userId}", userId)
        .replace("{from}", String(oneYearAgo))
        .replace("{to}", String(now));

    for (const api of APIS_TO_CHECK) {
      if (api.path.includes("{userId}") && !userId) {
        console.log(`  ${api.method.padEnd(5)} ${api.path}`);
        console.log(`    → SKIPPED  (사용자 ID 조회 실패, 테스트 불가)`);
        continue;
      }
      const url = `${config.flexBaseUrl}${substitute(api.path)}`;

      try {
        const headers = apiHeaders(authCtx);
        const init: RequestInit = { method: api.method, headers };
        if (api.method === "POST") {
          init.body = JSON.stringify({});
        }
        const res = await fetch(url, init);
        const text = await res.text().catch(() => "");
        let preview = "";
        try {
          const json = JSON.parse(text);
          preview = Object.keys(json).slice(0, 3).join(", ");
        } catch {
          preview = text.slice(0, 50);
        }
        const icon = res.status >= 200 && res.status < 300 ? "OK" : res.status === 404 ? "NOT FOUND" : `ERR ${res.status}`;
        console.log(`  ${api.method.padEnd(5)} ${api.path}`);
        console.log(`    → ${icon}  ${preview ? `(${preview})` : ""}`);
      } catch (error) {
        console.log(`  ${api.method.padEnd(5)} ${api.path}`);
        console.log(`    → FAIL  ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    console.log("\n  " + "-".repeat(56));
  } finally {
    await cleanup(authCtx);
  }
}
