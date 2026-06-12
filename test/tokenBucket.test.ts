import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Algorithm, type TokenBucketRule } from "../src/core/types.js";
import { limitKey } from "../src/core/keys.js";
import { makeRig, flush, type Rig } from "./helpers.js";

// Fixed base clock; every check passes nowOverrideMs so refill math is
// deterministic (production reads redis.call('TIME') instead).
const T = 1_700_000_000_000;

const rule = (over: Partial<TokenBucketRule> = {}): TokenBucketRule => ({
  ruleId: "r",
  algorithm: Algorithm.TokenBucket,
  capacity: 5,
  refillRate: 1, // tokens/sec
  ...over,
});

let rig: Rig;
beforeAll(async () => (rig = await makeRig()));
afterAll(async () => rig.close());
beforeEach(() => flush(rig.redis));

describe("token bucket", () => {
  it("admits a full burst then denies, with no refill at a frozen clock", async () => {
    const r = rule({ capacity: 5, refillRate: 1 });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
      seen.push(d.allowed ? d.remaining : -1);
    }
    // remaining after each of the 5 allowed, then -1 for the denied 6th.
    expect(seen).toEqual([4, 3, 2, 1, 0, -1]);

    const denied = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000); // 1 token at 1/sec
  });

  it("refills lazily over simulated time", async () => {
    const r = rule({ capacity: 5, refillRate: 1 });
    // Drain the bucket at T.
    for (let i = 0; i < 5; i++) {
      await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
    }
    // 2s later -> exactly 2 tokens refilled.
    const a = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T + 2000 });
    const b = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T + 2000 });
    const c = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T + 2000 });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(false); // only 2 had accrued
  });

  it("spends cost > 1 atomically", async () => {
    const r = rule({ capacity: 10, refillRate: 1 });
    const d = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", cost: 3, nowOverrideMs: T });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(7);
  });

  it("denies a request whose cost exceeds capacity", async () => {
    const r = rule({ capacity: 2, refillRate: 1 });
    const d = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", cost: 5, nowOverrideMs: T });
    expect(d.allowed).toBe(false);
    // Bucket is untouched — the over-cost request consumes nothing.
    expect(d.remaining).toBe(2);
  });

  it("sets a bounded TTL on the bucket key", async () => {
    const r = rule({ capacity: 5, refillRate: 1 });
    await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
    const ttl = await rig.redis.pttl(limitKey("t", "r", "u", Algorithm.TokenBucket));
    // full-refill time = capacity/refillRate = 5s = 5000ms.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5000);
  });
});
