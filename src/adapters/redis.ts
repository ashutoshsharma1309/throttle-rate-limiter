import { Redis, Cluster, type RedisOptions } from "ioredis";
import type { Config } from "./config.js";

/**
 * Redis adapter (lowest layer). Owns connection lifecycle, reconnection, the
 * per-command timeout, and cluster vs standalone selection. Lua script
 * registration is layered on top of this in adapters/scripts.ts (M2).
 *
 * `any` is tolerated in this file (and only here) because it sits at the raw
 * ioredis boundary.
 */
export type RedisClient = Redis | Cluster;

export function createRedis(cfg: Config): RedisClient {
  const common: RedisOptions = {
    // Surface failures fast instead of silently buffering commands while down —
    // the service layer's fail-open/closed policy needs to see the error.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: cfg.redisCommandTimeoutMs,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };

  if (cfg.redisCluster) {
    const u = new URL(cfg.redisUrl);
    return new Cluster([{ host: u.hostname, port: Number(u.port || 6379) }], {
      redisOptions: common,
      enableOfflineQueue: false,
    });
  }

  return new Redis(cfg.redisUrl, common);
}

/**
 * Resolve once the client is ready to accept commands, or after `timeoutMs`.
 * Needed because we run with enableOfflineQueue:false (fail-fast on the hot
 * path), so commands issued before the initial connect would be rejected.
 * Used at startup before preloading Lua. Never rejects — a still-not-ready
 * client just means the first real request will surface the error (and trip
 * the fail policy in M5).
 */
export function waitForReady(client: RedisClient, timeoutMs = 2000): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      client.off("ready", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    client.once("ready", done);
  });
}

/**
 * Liveness probe for the health endpoint. Returns false (never throws) if
 * Redis is unreachable or slow — `commandTimeout` bounds how long we wait.
 */
export async function redisIsUp(client: RedisClient): Promise<boolean> {
  try {
    const pong = await client.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}
