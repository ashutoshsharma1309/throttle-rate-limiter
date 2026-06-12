import type { FastifyReply } from "fastify";
import type { Decision } from "../../core/types.js";

/**
 * Apply the standard rate-limit headers to a REST reply. These mirror the
 * widely-used GitHub/Stripe convention so clients can back off generically:
 *   X-RateLimit-Limit     the ceiling
 *   X-RateLimit-Remaining tokens/slots left
 *   X-RateLimit-Reset     unix SECONDS when capacity replenishes
 * On a deny we also set Retry-After (seconds, ceil) and a 429 status.
 */
export function applyRateLimitHeaders(reply: FastifyReply, d: Decision): void {
  reply.header("X-RateLimit-Limit", d.limit);
  reply.header("X-RateLimit-Remaining", Math.max(0, d.remaining));
  reply.header("X-RateLimit-Reset", Math.ceil(d.resetMs / 1000));
  if (!d.allowed) {
    reply.header("Retry-After", Math.ceil(d.retryAfterMs / 1000));
  }
}

/** REST response body for a single check (shape differs allow vs deny per spec). */
export function checkBody(d: Decision): Record<string, unknown> {
  return d.allowed
    ? { allowed: true, remaining: d.remaining, limit: d.limit, resetMs: d.resetMs }
    : { allowed: false, remaining: 0, retryAfterMs: d.retryAfterMs };
}
