import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { authenticate, cleanup } from "../auth/index.js";

// 실제 time-off-uses 조회 URL에는 userId와 from..to 범위가 필요하다.
// check-apis는 라이트하게 엔드포인트 존재 여부만 확인하므로,
// userId 자리에 "me"를 쓰면 route 매칭에 실패한다. attendance 크롤러에서
// 사용자 ID를 먼저 조회한 뒤 실제 URL 형식을 그대로 사용한다.
const ME_USER_ID_LOOKUP_PATH =
  "/api/v2/core/users/me/workspace-users-corp-group-affiliates";

const APIS_TO_CHECK = [
  { label: "template-list", method: "GET", path: "/api/v3/approval-document-template/templates" },
  { label: "instance-search", method: "POST", path: "/action/v3/approval-document/user-boxes/search" },
  { label: "core-me", method: "GET", path: "/api/v2/core/me" },
  { label: "user-me-workspace (for user id lookup)", method: "GET", path: ME_USER_ID_LOOKUP_PATH },
  { label: "time-off-uses (old: 404)", method: "GET", path: "/api/v2/time-off/users/me/time-off-requests" },
  // 실제 사용되는 엔드포인트 형태. userId는 런타임에 주입되고 range는 타임스탬프 범위.
  // 여기서는 placeholder를 채워 route 매칭 여부만 확인한다.
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

    // 현재 사용자 ID를 먼저 조회 (time-off-uses 실 URL 구성용)
    let userId = "";
    try {
      const lookup = await authCtx.page.evaluate(
        async ([fetchUrl, headers]) => {
          const res = await fetch(fetchUrl, { headers: headers as Record<string, string> });
          if (!res.ok) return null;
          return await res.json();
        },
        [`${config.flexBaseUrl}${ME_USER_ID_LOOKUP_PATH}`, authCtx.authHeaders] as const,
      );
      userId = (lookup as { currentUser?: { user?: { userIdHash?: string } } } | null)
        ?.currentUser?.user?.userIdHash ?? "";
    } catch {
      // 사용자 조회 실패 시 placeholder 상태로 계속 진행
    }

    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const substitute = (path: string): string =>
      path
        .replace("{userId}", userId || "me")
        .replace("{from}", String(oneYearAgo))
        .replace("{to}", String(now));

    for (const api of APIS_TO_CHECK) {
      const url = `${config.flexBaseUrl}${substitute(api.path)}`;

      try {
        const result = await authCtx.page.evaluate(
          async ([fetchUrl, headers, method]) => {
            const opts: RequestInit = {
              method: method as string,
              headers: headers as Record<string, string>,
            };
            if (method === "POST") {
              (opts.headers as Record<string, string>)["content-type"] = "application/json";
              opts.body = JSON.stringify({});
            }
            const res = await fetch(fetchUrl, opts);
            const text = await res.text().catch(() => "");
            let preview = "";
            try {
              const json = JSON.parse(text);
              const keys = Object.keys(json);
              preview = keys.slice(0, 3).join(", ");
            } catch {
              preview = text.slice(0, 50);
            }
            return { status: res.status, preview };
          },
          [url, authCtx.authHeaders, api.method] as const,
        );

        const icon = result.status >= 200 && result.status < 300 ? "OK" : result.status === 404 ? "NOT FOUND" : `ERR ${result.status}`;
        console.log(`  ${api.method.padEnd(5)} ${api.path}`);
        console.log(`    → ${icon}  ${result.preview ? `(${result.preview})` : ""}`);
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
