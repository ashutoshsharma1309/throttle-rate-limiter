import { performance } from "node:perf_hooks";
import type { Logger } from "../logger.js";
import { ruleLimit, type Decision } from "../core/types.js";
import { DEFAULT_COST } from "../core/types.js";
import type { RateLimiter, CheckInput } from "../core/limiter.js";
import type { Metrics } from "../metrics.js";
import type { TenantStore } from "./tenantStore.js";
import type { RuleCache } from "./ruleCache.js";
import {
  BackendUnavailableError,
  InvalidRequestError,
  ServiceError,
  UnknownApiKeyError,
  UnknownRuleError,
} from "./errors.js";

export interface CheckRequest {
  apiKey: string;
  rule: string;
  identifier: string;
  cost?: number;
}

export interface BatchItem {
  rule: string;
  identifier: string;
  cost?: number;
}

export type BatchEntry = { decision: Decision } | { error: { code: string; message: string } };

export const MAX_BATCH = 50;

export interface FailPolicy {
  /** true => allow on backend failure; false => reject (503 / UNAVAILABLE). */
  failOpen: boolean;
}

/**
 * Orchestration shared by REST and gRPC: authenticate, resolve the rule
 * (cached), validate cost, run the limiter — and own the resilience policy.
 *
 * Error taxonomy that drives behaviour:
 *   - ServiceError (unknown key/rule, bad cost): a CLIENT error. Always
 *     propagates with its status. Never masked by the fail policy — a working
 *     backend that says "no such key" is a real 401, not an outage.
 *   - anything else (Redis down, the 50ms command timeout): a BACKEND error.
 *     Routed through fail-open/closed.
 */
export class RateLimitService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly rules: RuleCache,
    private readonly limiter: RateLimiter,
    private readonly metrics: Metrics,
    private readonly log: Logger,
    private readonly policy: FailPolicy,
  ) {}

  async check(req: CheckRequest): Promise<Decision> {
    const t0 = performance.now();
    try {
      const tenantId = await this.requireTenant(req.apiKey);
      const input = await this.resolve(tenantId, req.rule, req.identifier, req.cost);
      const decision = await this.limiter.check(input);

      const latencyMs = performance.now() - t0;
      this.metrics.incCheck(tenantId, req.rule, decision.allowed);
      this.metrics.observeDuration(latencyMs);
      // Structured per-check log. No identifier at info level (it may be PII).
      this.log.info(
        { tenant: tenantId, rule: req.rule, allowed: decision.allowed, latencyMs: round(latencyMs) },
        "check",
      );
      return decision;
    } catch (err) {
      if (err instanceof ServiceError) throw err; // client error — never masked
      return this.onBackendError(err, req.rule, performance.now() - t0);
    }
  }

  async checkBatch(apiKey: string, items: BatchItem[]): Promise<BatchEntry[]> {
    if (items.length === 0 || items.length > MAX_BATCH) {
      throw new InvalidRequestError(`batch size must be 1..${MAX_BATCH}`);
    }
    try {
      const tenantId = await this.requireTenant(apiKey);
      const entries: BatchEntry[] = new Array(items.length);
      const runnable: { index: number; input: CheckInput }[] = [];

      await Promise.all(
        items.map(async (it, i) => {
          try {
            runnable.push({
              index: i,
              input: await this.resolve(tenantId, it.rule, it.identifier, it.cost),
            });
          } catch (err) {
            if (!(err instanceof ServiceError)) throw err; // backend error -> abort batch
            entries[i] = errorEntry(err);
          }
        }),
      );

      const decisions = await this.limiter.checkBatch(runnable.map((r) => r.input));
      runnable.forEach((r, k) => {
        const decision = decisions[k]!;
        this.metrics.incCheck(tenantId, items[r.index]!.rule, decision.allowed);
        entries[r.index] = { decision };
      });
      return entries;
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      // Backend failure mid-batch: apply the fail policy uniformly to all items.
      this.metrics.incRedisError();
      this.log.warn({ err: (err as Error).message, failOpen: this.policy.failOpen }, "batch backend error");
      if (!this.policy.failOpen) throw new BackendUnavailableError();
      return items.map(() => ({ decision: degraded() }));
    }
  }

  private async requireTenant(apiKey: string): Promise<string> {
    const tenantId = apiKey ? await this.tenants.tenantIdForApiKey(apiKey) : null;
    if (!tenantId) throw new UnknownApiKeyError();
    return tenantId;
  }

  private async resolve(
    tenantId: string,
    ruleId: string,
    identifier: string,
    cost: number | undefined,
  ): Promise<CheckInput> {
    if (!identifier) throw new InvalidRequestError("identifier is required");
    const rule = await this.rules.get(tenantId, ruleId);
    if (!rule) throw new UnknownRuleError(ruleId);

    const effectiveCost = cost ?? rule.cost ?? DEFAULT_COST;
    if (effectiveCost > ruleLimit(rule)) {
      throw new InvalidRequestError(
        `cost ${effectiveCost} exceeds the rule ceiling ${ruleLimit(rule)}`,
      );
    }
    return { tenantId, rule, identifier, ...(cost !== undefined ? { cost } : {}) };
  }

  /**
   * Fail-open vs fail-closed — the central availability/safety trade-off:
   *   open   -> allow. The protected service stays reachable during a Redis
   *             outage, but limits aren't enforced (abuse/overload pass through).
   *   closed -> reject (503 / UNAVAILABLE). The backend is never unprotected,
   *             but a Redis outage becomes a self-inflicted outage of everything
   *             behind the limiter.
   * We log loudly and bump throttle_redis_errors_total on every degraded call.
   */
  private onBackendError(err: unknown, rule: string, latencyMs: number): Decision {
    this.metrics.incRedisError();
    this.metrics.observeDuration(latencyMs);
    this.log.warn(
      { err: (err as Error)?.message, failOpen: this.policy.failOpen, rule, latencyMs: round(latencyMs) },
      "rate-limit backend unavailable; applying fail policy",
    );
    if (!this.policy.failOpen) throw new BackendUnavailableError();
    return degraded();
  }
}

function degraded(): Decision {
  return { allowed: true, remaining: 0, limit: 0, retryAfterMs: 0, resetMs: Date.now(), degraded: true };
}

function errorEntry(err: ServiceError): BatchEntry {
  return { error: { code: err.code, message: err.message } };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
