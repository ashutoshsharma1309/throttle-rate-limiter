import { loadConfig, type Config } from "./adapters/config.js";
import { createRedis, type RedisClient } from "./adapters/redis.js";
import { LuaScripts } from "./adapters/scripts.js";
import { createLogger, type Logger } from "./logger.js";
import { Metrics } from "./metrics.js";
import { CheckEventBus } from "./events.js";
import { RateLimiter } from "./core/limiter.js";
import { TenantStore } from "./service/tenantStore.js";
import { RuleCache } from "./service/ruleCache.js";
import { RateLimitService } from "./service/rateLimitService.js";
import { AdminService } from "./service/adminService.js";

/**
 * Composition root: builds the shared dependency graph once and hands it to
 * both transports. Wiring lives here so transports stay thin and the layer
 * boundaries (transport -> service -> core -> adapters) are explicit.
 */
export interface AppServices {
  scripts: LuaScripts;
  limiter: RateLimiter;
  tenants: TenantStore;
  rules: RuleCache;
  rateLimit: RateLimitService;
  admin: AdminService;
  metrics: Metrics;
  events: CheckEventBus;
}

export interface AppContext {
  config: Config;
  logger: Logger;
  redis: RedisClient;
  services: AppServices;
  /** Process boot time, for uptime reporting on /v1/health. */
  startedAtMs: number;
}

export function buildApp(startedAtMs: number): AppContext {
  const config = loadConfig();
  const logger = createLogger(config);
  const redis = createRedis(config);

  redis.on("error", (err: Error) => {
    // Debug level: ioredis emits frequently while reconnecting. The service
    // layer logs loudly when a check actually degrades (M5).
    logger.debug({ err: err.message }, "redis connection error");
  });

  const metrics = new Metrics();
  const events = new CheckEventBus();
  const scripts = new LuaScripts(redis);
  const limiter = new RateLimiter(scripts);
  const tenants = new TenantStore(redis);
  const rules = new RuleCache(tenants, config.ruleCacheTtlMs);
  const rateLimit = new RateLimitService(
    tenants,
    rules,
    limiter,
    metrics,
    logger,
    { failOpen: config.failOpen },
    events,
  );
  const admin = new AdminService(tenants, rules);

  return {
    config,
    logger,
    redis,
    services: { scripts, limiter, tenants, rules, rateLimit, admin, metrics, events },
    startedAtMs,
  };
}
