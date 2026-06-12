import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Algorithm, type Rule } from "../src/core/types.js";
import { makeRig, flush, type Rig } from "./helpers.js";

const T = 1_700_000_000_000;

let rig: Rig;
beforeAll(async () => (rig = await makeRig()));
afterAll(async () => rig.close());
beforeEach(() => flush(rig.redis));

/**
 * The atomicity proof. Fire 100 checks at ONE key concurrently (Promise.all)
 * with a limit of 10 and assert EXACTLY 10 are admitted. If the check were an
 * app-side read-modify-write (ZCARD/HMGET then ZADD/HSET) the interleaving
 * would over-admit; because each check is a single atomic Lua script, the
 * count is exact regardless of concurrency.
 */
async function countAllowed(rule: Rule, n: number): Promise<number> {
  const checks = Array.from({ length: n }, () =>
    rig.limiter.check({ tenantId: "t", rule, identifier: "hot", nowOverrideMs: T }),
  );
  const results = await Promise.all(checks);
  return results.filter((d) => d.allowed).length;
}

describe("atomicity under concurrency (100 parallel -> exactly 10 allowed)", () => {
  it("token bucket admits exactly capacity under a parallel storm", async () => {
    const rule: Rule = {
      ruleId: "r",
      algorithm: Algorithm.TokenBucket,
      capacity: 10,
      refillRate: 1, // negligible refill at a frozen clock
    };
    expect(await countAllowed(rule, 100)).toBe(10);
  });

  it("sliding window admits exactly the limit under a parallel storm", async () => {
    const rule: Rule = {
      ruleId: "r",
      algorithm: Algorithm.SlidingWindow,
      limit: 10,
      windowMs: 60_000,
    };
    expect(await countAllowed(rule, 100)).toBe(10);
  });
});
