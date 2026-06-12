import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inject } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppContext } from "../src/app.js";
import { buildRestServer } from "../src/transports/rest/server.js";
import { waitForReady } from "../src/adapters/redis.js";

const ADMIN = "admin-test-key";

let ctx: AppContext;
let app: FastifyInstance;
let apiKey: string;
let tenantId: string;

beforeAll(async () => {
  process.env.REDIS_URL = inject("redisUrl");
  process.env.ADMIN_API_KEY = ADMIN;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "silent";

  ctx = buildApp(Date.now());
  await waitForReady(ctx.redis);
  await ctx.services.scripts.load();
  app = buildRestServer(ctx);
  await app.ready();

  // Provision a tenant + a strict token-bucket rule for the suite.
  const created = await app.inject({
    method: "POST",
    url: "/v1/admin/tenants",
    headers: { "x-api-key": ADMIN },
  });
  ({ tenantId, apiKey } = created.json());

  await app.inject({
    method: "PUT",
    url: `/v1/admin/tenants/${tenantId}/rules/tight`,
    headers: { "x-api-key": ADMIN, "content-type": "application/json" },
    payload: { algorithm: "token_bucket", capacity: 2, refillRate: 0.001 },
  });
});

afterAll(async () => {
  await app.close();
  ctx.redis.disconnect();
});

describe("REST transport", () => {
  it("health reports redis up", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", redis: "up" });
  });

  it("allows, sets X-RateLimit headers, then 429s with Retry-After", async () => {
    const u = `user-${Math.random()}`;
    const call = () =>
      app.inject({
        method: "POST",
        url: "/v1/check",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        payload: { rule: "tight", identifier: u },
      });

    const a = await call();
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ allowed: true, limit: 2 });
    expect(a.headers["x-ratelimit-limit"]).toBe("2");
    expect(a.headers["x-ratelimit-remaining"]).toBe("1");
    expect(a.headers["x-ratelimit-reset"]).toBeDefined();

    await call(); // spends the 2nd token
    const denied = await call();
    expect(denied.statusCode).toBe(429);
    expect(denied.json()).toMatchObject({ allowed: false, remaining: 0 });
    expect(denied.headers["retry-after"]).toBeDefined();
    expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rejects an unknown API key with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/check",
      headers: { "x-api-key": "nope", "content-type": "application/json" },
      payload: { rule: "tight", identifier: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNKNOWN_API_KEY");
  });

  it("rejects admin routes without the admin key (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/tenants",
      headers: { "x-api-key": apiKey }, // a tenant key, not the admin key
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects cost above the rule ceiling with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/check",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: { rule: "tight", identifier: "y", cost: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REQUEST");
  });

  it("exposes Prometheus metrics after checks have run", async () => {
    // A prior allowed check in this suite has populated the counters.
    await app.inject({
      method: "POST",
      url: "/v1/check",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: { rule: "tight", identifier: `m-${Math.random()}` },
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("throttle_checks_total{");
    expect(res.body).toContain("throttle_check_duration_ms_bucket");
    expect(res.body).toContain("throttle_redis_errors_total");
  });

  it("returns partial results from a batch (good + unknown rule)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/check/batch",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: {
        checks: [
          { rule: "tight", identifier: `b-${Math.random()}` },
          { rule: "does-not-exist", identifier: "z" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ allowed: true });
    expect(results[1].error.code).toBe("UNKNOWN_RULE");
  });
});
