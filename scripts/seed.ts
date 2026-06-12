/**
 * Seed a demo tenant + two rules, then print copy-paste curl and grpcurl
 * examples. Writes straight to Redis (no running server required) and is
 * idempotent — the demo credentials are stable across restarts.
 *
 *   pnpm seed                 # against REDIS_URL (default localhost:6379)
 */
import { loadConfig } from "../src/adapters/config.js";
import { createRedis, waitForReady } from "../src/adapters/redis.js";
import { TenantStore } from "../src/service/tenantStore.js";
import { Algorithm } from "../src/core/types.js";

const DEMO_TENANT = "demo-tenant";
const DEMO_KEY = "tk_demo_00000000000000000000000000000000";
const HTTP = process.env.HTTP_HOST ?? "localhost:8080";
const GRPC = process.env.GRPC_HOST ?? "localhost:50051";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const redis = createRedis(cfg);
  await waitForReady(redis);
  const store = new TenantStore(redis);

  await store.seedTenant(DEMO_TENANT, DEMO_KEY);
  await store.putRule(DEMO_TENANT, {
    ruleId: "free_tier",
    algorithm: Algorithm.SlidingWindow,
    limit: 100,
    windowMs: 60_000, // 100 requests / minute, exact
  });
  await store.putRule(DEMO_TENANT, {
    ruleId: "burst_api",
    algorithm: Algorithm.TokenBucket,
    capacity: 10, // burst of 10
    refillRate: 5, // sustained 5 req/sec
  });

  redis.disconnect();

  process.stdout.write(
    [
      "",
      "✅ Seeded demo tenant",
      `   tenantId : ${DEMO_TENANT}`,
      `   API key  : ${DEMO_KEY}`,
      "   rules    : free_tier (sliding_window 100/min), burst_api (token_bucket cap 10 @ 5/s)",
      "",
      "── REST ─────────────────────────────────────────────────────────────",
      `curl -s -XPOST http://${HTTP}/v1/check \\`,
      `  -H "x-api-key: ${DEMO_KEY}" -H "content-type: application/json" \\`,
      `  -d '{"rule":"burst_api","identifier":"user-1"}'`,
      "",
      `curl -s http://${HTTP}/v1/health`,
      `curl -s http://${HTTP}/metrics`,
      "",
      "── gRPC (grpcurl; uses the proto in ./proto) ────────────────────────",
      `grpcurl -plaintext -import-path ./proto -proto throttle.proto \\`,
      `  -H "x-api-key: ${DEMO_KEY}" \\`,
      `  -d '{"rule":"burst_api","identifier":"user-1"}' \\`,
      `  ${GRPC} throttle.v1.RateLimiter/Check`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
