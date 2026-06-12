import { describe, it, expect } from "vitest";
import { Redis } from "ioredis";
import { pino } from "pino";
import { LuaScripts } from "../src/adapters/scripts.js";
import { RateLimiter } from "../src/core/limiter.js";
import { Metrics } from "../src/metrics.js";
import { TenantStore } from "../src/service/tenantStore.js";
import { RuleCache } from "../src/service/ruleCache.js";
import { RateLimitService } from "../src/service/rateLimitService.js";
import { BackendUnavailableError } from "../src/service/errors.js";

/**
 * Simulate "Redis down" by pointing the service at a dead port (the shared
 * test container is left untouched). With enableOfflineQueue:false every
 * command fails fast — exactly the path the fail policy must handle.
 */
function deadService(failOpen: boolean) {
  const redis = new Redis(11999, "127.0.0.1", {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 50,
    retryStrategy: () => null, // don't reconnect — stay down for the test
  });
  redis.on("error", () => {}); // swallow connection errors
  const metrics = new Metrics();
  const svc = new RateLimitService(
    new TenantStore(redis),
    new RuleCache(new TenantStore(redis), 30_000),
    new RateLimiter(new LuaScripts(redis)),
    metrics,
    pino({ level: "silent" }),
    { failOpen },
  );
  return { svc, redis, metrics };
}

describe("resilience: fail-open vs fail-closed when Redis is down", () => {
  it("fail-open: allows a degraded request and counts the redis error", async () => {
    const { svc, redis, metrics } = deadService(true);
    const d = await svc.check({ apiKey: "k", rule: "r", identifier: "i" });
    expect(d.allowed).toBe(true);
    expect(d.degraded).toBe(true);
    expect(metrics.render()).toMatch(/throttle_redis_errors_total [1-9]/);
    redis.disconnect();
  });

  it("fail-closed: rejects with BackendUnavailableError (503 / UNAVAILABLE)", async () => {
    const { svc, redis } = deadService(false);
    await expect(svc.check({ apiKey: "k", rule: "r", identifier: "i" })).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
    redis.disconnect();
  });

  it("fail-open batch: every item degrades to allowed", async () => {
    const { svc, redis } = deadService(true);
    const entries = await svc.checkBatch("k", [
      { rule: "a", identifier: "1" },
      { rule: "b", identifier: "2" },
    ]);
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect("decision" in e && e.decision.allowed).toBe(true);
    }
    redis.disconnect();
  });
});
