import { Redis } from "ioredis";
import { inject } from "vitest";
import { LuaScripts } from "../src/adapters/scripts.js";
import { RateLimiter } from "../src/core/limiter.js";

/**
 * Test rig: a real ioredis client against the Testcontainers Redis, plus a
 * warmed LuaScripts registry and a RateLimiter built on it.
 */
export interface Rig {
  redis: Redis;
  scripts: LuaScripts;
  limiter: RateLimiter;
  close(): Promise<void>;
}

export async function makeRig(): Promise<Rig> {
  const redis = new Redis(inject("redisUrl"), { maxRetriesPerRequest: null });
  const scripts = new LuaScripts(redis);
  await scripts.load();
  const limiter = new RateLimiter(scripts);
  return {
    redis,
    scripts,
    limiter,
    async close() {
      await redis.quit();
    },
  };
}

/** Wipe the keyspace between tests so keys don't leak across cases. */
export async function flush(redis: Redis): Promise<void> {
  await redis.flushall();
}
