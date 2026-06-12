import { randomUUID } from "node:crypto";
import { Algorithm, DEFAULT_COST, ruleLimit, type Decision, type Rule } from "./types.js";
import { limitKey } from "./keys.js";
import type { LuaScripts, LuaReply, ScriptName } from "../adapters/scripts.js";

export interface CheckInput {
  tenantId: string;
  rule: Rule;
  identifier: string;
  /** Per-request cost; falls back to rule.cost then DEFAULT_COST. */
  cost?: number;
  /**
   * TEST ONLY. ms to use instead of the Redis server clock. Production passes
   * 0 (the default) so the script reads redis.call('TIME').
   */
  nowOverrideMs?: number;
}

interface ScriptItem {
  name: ScriptName;
  keys: string[];
  args: (string | number)[];
}

/**
 * Limiter core: pure dispatch from a Rule to its atomic Lua script. Holds no
 * Redis or transport knowledge beyond the LuaScripts adapter handed in. The
 * scripts do the read-compute-write atomically; this layer builds keys/args and
 * shapes the reply into a Decision.
 */
export class RateLimiter {
  constructor(private readonly scripts: LuaScripts) {}

  async check(input: CheckInput): Promise<Decision> {
    const reply = await this.scripts.run(...itemTuple(buildItem(input)));
    return shape(input.rule, reply);
  }

  /** Evaluate many checks in one pipelined round-trip; results stay positional. */
  async checkBatch(inputs: CheckInput[]): Promise<Decision[]> {
    const replies = await this.scripts.runMany(inputs.map(buildItem));
    return replies.map((reply, i) => shape(inputs[i]!.rule, reply));
  }
}

function buildItem(input: CheckInput): ScriptItem {
  const { tenantId, rule, identifier } = input;
  const cost = input.cost ?? rule.cost ?? DEFAULT_COST;
  const now = input.nowOverrideMs ?? 0;
  const key = limitKey(tenantId, rule.ruleId, identifier, rule.algorithm);

  if (rule.algorithm === Algorithm.TokenBucket) {
    return { name: "token_bucket", keys: [key], args: [rule.capacity, rule.refillRate, cost, now] };
  }
  // Unique per call so concurrent admits in the same ms don't collide as ZSET members.
  return {
    name: "sliding_window",
    keys: [key],
    args: [rule.limit, rule.windowMs, cost, now, randomUUID()],
  };
}

function itemTuple(item: ScriptItem): [ScriptName, string[], (string | number)[]] {
  return [item.name, item.keys, item.args];
}

function shape(rule: Rule, reply: LuaReply): Decision {
  const [allowed, remaining, retryAfterMs, resetMs] = reply;
  return {
    allowed: allowed === 1,
    remaining,
    limit: ruleLimit(rule),
    retryAfterMs,
    resetMs,
  };
}
