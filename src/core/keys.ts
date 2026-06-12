import { Algorithm } from "./types.js";

/**
 * Redis key construction with a Cluster hash tag.
 *
 *   throttle:{tenantId:ruleId:identifier}:tb
 *            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ hashed for slot selection
 *
 * Redis Cluster hashes only the substring inside `{...}` when choosing a slot.
 * Putting the whole logical identity inside the braces guarantees every key
 * for one (tenant, rule, identifier) lands on a single slot — required because
 * a Lua script may only touch keys that live in the same slot (else CROSSSLOT).
 * Different identifiers still spread across the cluster, so no single node
 * becomes a hot spot for the whole tenant.
 */
export function limitKey(
  tenantId: string,
  ruleId: string,
  identifier: string,
  algorithm: Algorithm,
): string {
  const suffix = algorithm === Algorithm.TokenBucket ? "tb" : "sw";
  return `throttle:{${tenantId}:${ruleId}:${identifier}}:${suffix}`;
}
