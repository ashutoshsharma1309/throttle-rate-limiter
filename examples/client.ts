/**
 * Tiny library-consumer example: a typed wrapper a service would embed to call
 * Throttle over REST. Run the server + `pnpm seed`, then:
 *
 *   npx tsx examples/client.ts
 */

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  limit?: number;
  resetMs?: number;
  retryAfterMs?: number;
}

export class ThrottleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /** Returns the decision. allowed=false means rate-limited (HTTP 429). */
  async check(rule: string, identifier: string, cost?: number): Promise<CheckResult> {
    const res = await fetch(`${this.baseUrl}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({ rule, identifier, ...(cost ? { cost } : {}) }),
    });
    if (res.status !== 200 && res.status !== 429) {
      throw new Error(`throttle error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as CheckResult;
  }
}

// Demo when run directly.
async function demo(): Promise<void> {
  const client = new ThrottleClient(
    process.env.BASE_URL ?? "http://localhost:8080",
    process.env.API_KEY ?? "tk_demo_00000000000000000000000000000000",
  );

  for (let i = 1; i <= 12; i++) {
    const d = await client.check("burst_api", "demo-user");
    if (d.allowed) {
      console.log(`#${i} allowed  (remaining ${d.remaining})`);
    } else {
      console.log(`#${i} BLOCKED  (retry in ${d.retryAfterMs}ms)`);
    }
  }
}

// Only run the demo when invoked as a script, not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  demo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
