import { pino, type Logger } from "pino";
import type { Config } from "./adapters/config.js";

/**
 * Structured JSON logging (cross-cutting). Pretty-prints in development for
 * readability; emits raw JSON in production for log shippers.
 */
export function createLogger(cfg: Config): Logger {
  const pretty = cfg.nodeEnv === "development";
  return pino({
    level: cfg.logLevel,
    base: { service: "throttle" },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l" } } }
      : {}),
  });
}

export type { Logger };
