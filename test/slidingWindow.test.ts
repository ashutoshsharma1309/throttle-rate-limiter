import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Algorithm, type SlidingWindowRule } from "../src/core/types.js";
import { limitKey } from "../src/core/keys.js";
import { makeRig, flush, type Rig } from "./helpers.js";

const T = 1_700_000_000_000;

const rule = (over: Partial<SlidingWindowRule> = {}): SlidingWindowRule => ({
  ruleId: "r",
  algorithm: Algorithm.SlidingWindow,
  limit: 3,
  windowMs: 1000,
  ...over,
});

let rig: Rig;
beforeAll(async () => (rig = await makeRig()));
afterAll(async () => rig.close());
beforeEach(() => flush(rig.redis));

describe("sliding window log", () => {
  it("admits up to the limit then denies within the window", async () => {
    const r = rule({ limit: 3, windowMs: 1000 });
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const d = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
      results.push(d.allowed);
    }
    expect(results).toEqual([true, true, true, false]);
  });

  it("honours the exact window boundary (windowMs-1 denied, windowMs+1 allowed)", async () => {
    const r = rule({ limit: 1, windowMs: 1000 });
    const first = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
    expect(first.allowed).toBe(true);

    // Still inside the window: the entry at T has not rolled off yet.
    const inside = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T + 999 });
    expect(inside.allowed).toBe(false);
    expect(inside.retryAfterMs).toBe(1); // frees up 1ms later

    // Past the window: the entry at T is evicted, so a new request is admitted.
    const after = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T + 1001 });
    expect(after.allowed).toBe(true);
  });

  it("reports resetMs as oldest-entry + window", async () => {
    const r = rule({ limit: 5, windowMs: 2000 });
    const d = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
    expect(d.resetMs).toBe(T + 2000);
  });

  it("admits cost > 1 as multiple entries", async () => {
    const r = rule({ limit: 5, windowMs: 1000 });
    const d = await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", cost: 4, nowOverrideMs: T });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(1);
    const card = await rig.redis.zcard(limitKey("t", "r", "u", Algorithm.SlidingWindow));
    expect(card).toBe(4);
  });

  it("sets a TTL equal to the window", async () => {
    const r = rule({ limit: 3, windowMs: 1000 });
    await rig.limiter.check({ tenantId: "t", rule: r, identifier: "u", nowOverrideMs: T });
    const ttl = await rig.redis.pttl(limitKey("t", "r", "u", Algorithm.SlidingWindow));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1000);
  });
});
