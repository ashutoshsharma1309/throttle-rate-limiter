/**
 * Core domain types. Dependency-free so the limiter logic can be reasoned
 * about and tested in isolation from Redis and the transports.
 */

export enum Algorithm {
  TokenBucket = "token_bucket",
  SlidingWindow = "sliding_window",
}

export function isAlgorithm(v: unknown): v is Algorithm {
  return v === Algorithm.TokenBucket || v === Algorithm.SlidingWindow;
}

/** Tokens spent per request when neither the rule nor the call specifies one. */
export const DEFAULT_COST = 1;

interface RuleBase {
  ruleId: string;
  /** Default tokens/entries a request consumes; per-call cost can override. */
  cost?: number;
}

export interface TokenBucketRule extends RuleBase {
  algorithm: Algorithm.TokenBucket;
  /** Bucket size — the maximum instantaneous burst. */
  capacity: number;
  /** Steady-state refill in tokens per second. */
  refillRate: number;
}

export interface SlidingWindowRule extends RuleBase {
  algorithm: Algorithm.SlidingWindow;
  /** Max admitted requests within any rolling window. */
  limit: number;
  windowMs: number;
}

export type Rule = TokenBucketRule | SlidingWindowRule;

/** The configured ceiling reported as X-RateLimit-Limit, per algorithm. */
export function ruleLimit(rule: Rule): number {
  return rule.algorithm === Algorithm.TokenBucket ? rule.capacity : rule.limit;
}

/** The atomic outcome of a single check. */
export interface Decision {
  allowed: boolean;
  /** Tokens / slots remaining after this check. */
  remaining: number;
  /** The rule's ceiling (capacity or limit). */
  limit: number;
  /** ms until a retry could succeed. 0 when allowed. */
  retryAfterMs: number;
  /** Epoch ms when capacity is (next) replenished — drives X-RateLimit-Reset. */
  resetMs: number;
  /** True when produced by the fail-open fallback rather than a real check. */
  degraded?: boolean;
}
