/**
 * Config loader (adapters layer). Reads + validates the environment exactly
 * once at boot so every other layer depends on a typed, frozen object rather
 * than poking at process.env. Throws early on bad input — fail fast, not at
 * the first request.
 */

export interface Config {
  nodeEnv: string;
  logLevel: string;

  httpPort: number;
  grpcPort: number;

  redisUrl: string;
  redisCluster: boolean;
  /** Per-command Redis timeout. A slow Redis is treated like a down Redis. */
  redisCommandTimeoutMs: number;

  /** true => allow on Redis failure; false => reject (503 / UNAVAILABLE). */
  failOpen: boolean;

  /** Guards the /v1/admin/* routes. Separate from any tenant key. */
  adminApiKey: string;

  /** In-process rule cache TTL — staleness window for rule changes. */
  ruleCacheTtlMs: number;
}

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Env ${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`Env ${name} must be true/false, got "${raw}"`);
}

export function loadConfig(): Config {
  return Object.freeze({
    nodeEnv: str("NODE_ENV", "development"),
    logLevel: str("LOG_LEVEL", "info"),

    httpPort: int("HTTP_PORT", 8080),
    grpcPort: int("GRPC_PORT", 50051),

    redisUrl: str("REDIS_URL", "redis://127.0.0.1:6379"),
    redisCluster: bool("REDIS_CLUSTER", false),
    redisCommandTimeoutMs: int("REDIS_COMMAND_TIMEOUT_MS", 50),

    failOpen: bool("FAIL_OPEN", true),

    adminApiKey: str("ADMIN_API_KEY", "dev-admin-key-change-me"),

    ruleCacheTtlMs: int("RULE_CACHE_TTL_MS", 30_000),
  });
}

export type { Config as AppConfig };
