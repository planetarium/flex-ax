import { loadConfig } from "../config/index.js";
import { createLogger } from "../logger/index.js";
import { authenticate, cleanup } from "../auth/index.js";

const APIS_TO_CHECK = [
  { label: "template-list", method: "GET", path: "/api/v3/approval-document-template/templates" },
  { label: "instance-search", method: "POST", path: "/action/v3/approval-document/user-boxes/search" },
  { label: "core-me", method: "GET", path: "/api/v2/core/me" },
  // 수정된 근태 API (userId는 core/me에서 가져와야 하므로 여기선 me로 테스트)
  { label: "time-off-uses (old: 404)", method: "GET", path: "/api/v2/time-off/users/me/time-off-requests" },
  { label: "time-off-uses (new)", method: "GET", path: "/api/v2/time-off/users/me/time-off-uses" },
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

    for (const api of APIS_TO_CHECK) {
      const url = `${config.flexBaseUrl}${api.path}`;

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
