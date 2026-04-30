import {
  authenticate,
  cleanup,
  listCorporations,
  switchCustomer,
  type AuthContext,
  type Corporation,
} from "../auth/index.js";
import { loadConfig, type Config } from "../config/index.js";
import { createLogger, type Logger } from "../logger/index.js";

export interface CommonLiveOpts {
  customer?: string;
}

export interface LiveCommandContext {
  authCtx: AuthContext;
  config: Config;
  corp: Corporation;
  logger: Logger;
}

export function resolveTargetCorporation(
  corporations: Corporation[],
  opts: CommonLiveOpts,
  config: Config,
  logger: Logger,
): Corporation {
  if (opts.customer) {
    const found = corporations.find((candidate) => candidate.customerIdHash === opts.customer);
    if (!found) {
      logger.error("--customer로 지정한 법인이 접근 가능 목록에 없습니다", {
        requested: opts.customer,
        available: corporations.map((candidate) => candidate.customerIdHash),
      });
      process.exit(1);
    }
    return found;
  }

  if (config.customers.length === 1) {
    const found = corporations.find((candidate) => candidate.customerIdHash === config.customers[0]);
    if (!found) {
      logger.error("FLEX_CUSTOMERS env로 지정한 법인이 접근 가능 목록에 없습니다");
      process.exit(1);
    }
    return found;
  }

  if (corporations.length === 1) {
    return corporations[0];
  }

  const representatives = corporations.filter((candidate) => candidate.isRepresentative);
  if (representatives.length === 1) {
    const target = representatives[0];
    logger.warn("법인이 여러 개라 대표 법인을 자동 선택합니다. 다른 법인을 쓰려면 --customer를 지정하세요.", {
      selected: { id: target.customerIdHash, name: target.name },
      candidates: corporations.map((candidate) => ({
        id: candidate.customerIdHash,
        name: candidate.name,
        isRepresentative: candidate.isRepresentative,
      })),
    });
    return target;
  }

  logger.error("법인이 여러 개입니다 — --customer <customerIdHash> 로 명시하세요", {
    candidates: corporations.map((candidate) => ({
      id: candidate.customerIdHash,
      name: candidate.name,
      isRepresentative: candidate.isRepresentative,
    })),
  });
  process.exit(1);
}

export async function setupLiveCommandContext(
  logLabel: string,
  opts: CommonLiveOpts,
): Promise<LiveCommandContext> {
  const logger = createLogger(logLabel);

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  const authCtx = await authenticate(config, logger);

  let corporations: Corporation[];
  try {
    corporations = await listCorporations(authCtx, config.flexBaseUrl);
  } catch (error) {
    await cleanup(authCtx);
    throw error;
  }

  if (corporations.length === 0) {
    await cleanup(authCtx);
    logger.error("접근 가능한 법인이 없습니다");
    process.exit(1);
  }

  const corp = resolveTargetCorporation(corporations, opts, config, logger);

  await switchCustomer(authCtx, config.flexBaseUrl, corp.customerIdHash, corp.userIdHash);
  logger.info("법인 컨텍스트 설정", { name: corp.name, customerIdHash: corp.customerIdHash });

  return { authCtx, config, corp, logger };
}

export async function withLiveCommandContext<T>(
  logLabel: string,
  opts: CommonLiveOpts,
  run: (ctx: LiveCommandContext) => Promise<T>,
): Promise<T> {
  const ctx = await setupLiveCommandContext(logLabel, opts);
  try {
    return await run(ctx);
  } finally {
    await cleanup(ctx.authCtx);
  }
}
