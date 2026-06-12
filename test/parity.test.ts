import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inject } from "vitest";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppContext } from "../src/app.js";
import { buildRestServer } from "../src/transports/rest/server.js";
import { buildGrpcServer, startGrpcServer, stopGrpcServer } from "../src/transports/grpc/server.js";
import { waitForReady } from "../src/adapters/redis.js";

const ADMIN = "admin-test-key";
const PROTO_PATH = fileURLToPath(new URL("../proto/throttle.proto", import.meta.url));

// Minimal typed gRPC client (no `any`).
interface CheckReq {
  rule: string;
  identifier: string;
  cost?: number;
}
interface CheckRes {
  allowed: boolean;
  remaining: number;
  limit: number;
  retry_after_ms: number;
  reset_ms: number;
}
type Unary<Q, R> = (
  req: Q,
  meta: grpc.Metadata,
  cb: (err: grpc.ServiceError | null, res?: R) => void,
) => void;
interface RlClient extends grpc.Client {
  check: Unary<CheckReq, CheckRes>;
  health: Unary<unknown, { status: string; redis: string; uptime_ms: number }>;
}

let ctx: AppContext;
let rest: FastifyInstance;
let grpcServer: grpc.Server;
let client: RlClient;
let apiKey: string;
let tenantId: string;
let meta: grpc.Metadata;

function makeClient(port: number): RlClient {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(pkgDef) as unknown as {
    throttle: { v1: { RateLimiter: grpc.ServiceClientConstructor } };
  };
  const Ctor = loaded.throttle.v1.RateLimiter;
  return new Ctor(`127.0.0.1:${port}`, grpc.credentials.createInsecure()) as unknown as RlClient;
}

beforeAll(async () => {
  process.env.REDIS_URL = inject("redisUrl");
  process.env.ADMIN_API_KEY = ADMIN;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "silent";

  ctx = buildApp(Date.now());
  await waitForReady(ctx.redis);
  await ctx.services.scripts.load();

  rest = buildRestServer(ctx);
  await rest.ready();
  grpcServer = buildGrpcServer(ctx);
  const port = await startGrpcServer(grpcServer, 0);
  client = makeClient(port);

  const created = await rest.inject({
    method: "POST",
    url: "/v1/admin/tenants",
    headers: { "x-api-key": ADMIN },
  });
  ({ tenantId, apiKey } = created.json());
  meta = new grpc.Metadata();
  meta.set("x-api-key", apiKey);

  await rest.inject({
    method: "PUT",
    url: `/v1/admin/tenants/${tenantId}/rules/win`,
    headers: { "x-api-key": ADMIN, "content-type": "application/json" },
    payload: { algorithm: "sliding_window", limit: 3, windowMs: 60_000 },
  });
});

afterAll(async () => {
  client.close();
  await stopGrpcServer(grpcServer);
  await rest.close();
  ctx.redis.disconnect();
});

describe("REST / gRPC parity (shared core)", () => {
  it("produces identical decision sequences for the same rule", async () => {
    const grpcCheck = promisify(client.check.bind(client)) as (
      req: CheckReq,
      meta: grpc.Metadata,
    ) => Promise<CheckRes>;

    const restSeq: { allowed: boolean; remaining: number }[] = [];
    const grpcSeq: { allowed: boolean; remaining: number }[] = [];

    // Distinct identifiers so the two transports don't share window state — we
    // compare the SHAPE of the decisions, which must match if the core is shared.
    for (let i = 0; i < 4; i++) {
      const r = await rest.inject({
        method: "POST",
        url: "/v1/check",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        payload: { rule: "win", identifier: "rest-user" },
      });
      const body = r.json();
      restSeq.push({ allowed: body.allowed, remaining: body.remaining });

      const g = await grpcCheck({ rule: "win", identifier: "grpc-user" }, meta);
      grpcSeq.push({ allowed: g.allowed, remaining: g.remaining });
    }

    expect(restSeq.map((x) => x.allowed)).toEqual([true, true, true, false]);
    expect(grpcSeq).toEqual(restSeq); // identical decisions across transports
  });

  it("maps unknown-rule to 404 (REST) and NOT_FOUND (gRPC)", async () => {
    const r = await rest.inject({
      method: "POST",
      url: "/v1/check",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      payload: { rule: "ghost", identifier: "u" },
    });
    expect(r.statusCode).toBe(404);

    const err = await new Promise<grpc.ServiceError>((resolve) => {
      client.check({ rule: "ghost", identifier: "u" }, meta, (e) => resolve(e as grpc.ServiceError));
    });
    expect(err.code).toBe(grpc.status.NOT_FOUND);
  });

  it("reports health consistently on both transports", async () => {
    const r = (await rest.inject({ method: "GET", url: "/v1/health" })).json();
    const g = await new Promise<{ status: string; redis: string }>((resolve, reject) => {
      client.health({}, meta, (e, res) => (e ? reject(e) : resolve(res!)));
    });
    expect(r.status).toBe("ok");
    expect(g.status).toBe("ok");
    expect(r.redis).toBe(g.redis);
  });
});
