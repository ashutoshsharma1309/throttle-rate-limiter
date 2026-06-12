/**
 * Load test: three scenarios via autocannon, results as a markdown table.
 *   1. single hot key     — worst-case contention on one Redis key/slot
 *   2. 1000 distinct keys — realistic spread across many limiter keys
 *   3. batch (50 checks)  — amortised: 50 limits per HTTP request, one pipeline
 *
 * Assumes a running server (docker compose up) seeded with the demo key
 * (pnpm seed). Override with BASE_URL / API_KEY env vars.
 */
import os from "node:os";
import autocannon, { type Options, type Result } from "autocannon";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const KEY = process.env.API_KEY ?? "tk_demo_00000000000000000000000000000000";
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);

const headers = { "content-type": "application/json", "x-api-key": KEY };

function run(opts: Options): Promise<Result> {
  return new Promise((resolve, reject) => {
    autocannon(opts, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

async function main(): Promise<void> {
  const common = { url: BASE, connections: CONNECTIONS, duration: DURATION, headers } as const;

  // 1. Single hot key.
  const hot = await run({
    ...common,
    title: "single hot key",
    requests: [
      { method: "POST", path: "/v1/check", body: JSON.stringify({ rule: "burst_api", identifier: "hot" }) },
    ],
  });

  // 2. 1000 distinct keys — randomise the identifier per request.
  const distinct = await run({
    ...common,
    title: "1000 distinct keys",
    requests: [
      {
        method: "POST",
        path: "/v1/check",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setupRequest: (req: any) => {
          const id = `u${Math.floor(Math.random() * 1000)}`;
          req.body = JSON.stringify({ rule: "burst_api", identifier: id });
          return req;
        },
      },
    ],
  });

  // 3. Batch of 50 checks per request.
  const batchBody = JSON.stringify({
    checks: Array.from({ length: 50 }, (_, i) => ({ rule: "burst_api", identifier: `b${i}` })),
  });
  const batch = await run({
    ...common,
    title: "batch (50 checks/req)",
    requests: [{ method: "POST", path: "/v1/check/batch", body: batchBody }],
  });

  printTable([hot, distinct, batch]);
}

function printTable(results: Result[]): void {
  const rows = results.map((r) => {
    const rps = Math.round(r.requests.average);
    // checks/sec: the batch scenario does 50 limiter checks per request.
    const checksPerSec = r.title?.startsWith("batch") ? rps * 50 : rps;
    return `| ${r.title} | ${rps} | ${checksPerSec} | ${r.latency.p50} | ${r.latency.p97_5} | ${r.latency.p99} |`;
  });

  const cpu = os.cpus()[0]?.model ?? "unknown";
  process.stdout.write(
    [
      "",
      `Machine: ${os.type()} ${os.release()} · ${os.cpus().length} vCPU · ${cpu} · Node ${process.version}`,
      `Config: ${CONNECTIONS} connections · ${DURATION}s each`,
      "",
      "| Scenario | Req/s | Checks/s | p50 (ms) | p97.5 (ms) | p99 (ms) |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
      "",
      "_autocannon reports p97.5, not p95._",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error("loadtest failed:", err);
  process.exit(1);
});
