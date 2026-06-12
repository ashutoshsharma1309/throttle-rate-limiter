import { Algorithm, isAlgorithm, type Rule } from "../core/types.js";
import { InvalidRequestError } from "./errors.js";

/**
 * Parse + validate an untrusted rule definition (admin PUT body) into a typed
 * Rule. Rejects malformed input at the boundary so bad data never reaches the
 * limiter or Redis.
 */
export function parseRule(ruleId: string, body: unknown): Rule {
  if (typeof body !== "object" || body === null) {
    throw new InvalidRequestError("rule body must be an object");
  }
  const b = body as Record<string, unknown>;

  if (!isAlgorithm(b.algorithm)) {
    throw new InvalidRequestError(`algorithm must be "token_bucket" or "sliding_window"`);
  }
  const cost = optionalPositiveInt(b.cost, "cost");

  if (b.algorithm === Algorithm.TokenBucket) {
    const capacity = positiveNumber(b.capacity, "capacity");
    const refillRate = positiveNumber(b.refillRate, "refillRate");
    return { ruleId, algorithm: Algorithm.TokenBucket, capacity, refillRate, ...(cost ? { cost } : {}) };
  }

  const limit = positiveInt(b.limit, "limit");
  const windowMs = positiveInt(b.windowMs, "windowMs");
  return { ruleId, algorithm: Algorithm.SlidingWindow, limit, windowMs, ...(cost ? { cost } : {}) };
}

function positiveNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new InvalidRequestError(`${name} must be a positive number`);
  }
  return v;
}

function positiveInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new InvalidRequestError(`${name} must be a positive integer`);
  }
  return v;
}

function optionalPositiveInt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  return positiveInt(v, name);
}

/** Validate a per-request cost against an untrusted check body. */
export function parseCost(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  return positiveInt(v, "cost");
}
