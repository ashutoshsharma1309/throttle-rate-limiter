import * as grpc from "@grpc/grpc-js";
import type { AppContext } from "../../app.js";
import type { Decision } from "../../core/types.js";
import { redisIsUp } from "../../adapters/redis.js";
import { ServiceError } from "../../service/errors.js";
import type { BatchEntry, BatchItem } from "../../service/rateLimitService.js";

// Wire shapes (proto-loader, keepCase:true, longs:Number).
interface GrpcCheckRequest {
  rule: string;
  identifier: string;
  cost: number; // 0 => default
}
interface GrpcCheckResponse {
  allowed: boolean;
  remaining: number;
  limit: number;
  retry_after_ms: number;
  reset_ms: number;
}
interface GrpcBatchEntry {
  decision?: GrpcCheckResponse;
  error?: { code: string; message: string };
}

function apiKey(call: grpc.ServerUnaryCall<unknown, unknown>): string {
  const v = call.metadata.get("x-api-key")[0];
  return v ? String(v) : "";
}

/** Per-request cost: proto uint32 defaults to 0, which means "use rule default". */
function costOf(req: GrpcCheckRequest): number | undefined {
  return req.cost && req.cost > 0 ? req.cost : undefined;
}

function toResponse(d: Decision): GrpcCheckResponse {
  return {
    allowed: d.allowed,
    remaining: Math.max(0, d.remaining),
    limit: d.limit,
    retry_after_ms: d.allowed ? 0 : d.retryAfterMs,
    reset_ms: d.resetMs,
  };
}

/** Map a thrown error to a gRPC status. Denials are NOT errors (allowed=false). */
function toGrpcError(err: unknown): grpc.ServerErrorResponse {
  const known = err instanceof ServiceError ? err : null;
  const code = known ? known.grpcCode : grpc.status.INTERNAL;
  const message = known ? known.message : "internal error";
  const out = new Error(message) as grpc.ServerErrorResponse;
  out.code = code;
  out.details = message;
  return out;
}

/**
 * gRPC service implementation. Thin: read metadata, call the SAME
 * RateLimitService the REST routes use, translate the result back to proto.
 * Zero limiter logic here.
 */
export function makeHandlers(ctx: AppContext): grpc.UntypedServiceImplementation {
  const { rateLimit } = ctx.services;

  return {
    Check: (
      call: grpc.ServerUnaryCall<GrpcCheckRequest, GrpcCheckResponse>,
      cb: grpc.sendUnaryData<GrpcCheckResponse>,
    ): void => {
      const req = call.request;
      rateLimit
        .check({
          apiKey: apiKey(call),
          rule: req.rule,
          identifier: req.identifier,
          ...(costOf(req) !== undefined ? { cost: costOf(req) } : {}),
        })
        .then((d) => cb(null, toResponse(d)))
        .catch((err: unknown) => cb(toGrpcError(err)));
    },

    CheckBatch: (
      call: grpc.ServerUnaryCall<{ checks: GrpcCheckRequest[] }, { results: GrpcBatchEntry[] }>,
      cb: grpc.sendUnaryData<{ results: GrpcBatchEntry[] }>,
    ): void => {
      const items: BatchItem[] = (call.request.checks ?? []).map((c) => ({
        rule: c.rule,
        identifier: c.identifier,
        ...(costOf(c) !== undefined ? { cost: costOf(c) } : {}),
      }));
      rateLimit
        .checkBatch(apiKey(call), items)
        .then((entries) => cb(null, { results: entries.map(toBatchEntry) }))
        .catch((err: unknown) => cb(toGrpcError(err)));
    },

    Health: (
      _call: grpc.ServerUnaryCall<unknown, unknown>,
      cb: grpc.sendUnaryData<{ status: string; redis: string; uptime_ms: number }>,
    ): void => {
      redisIsUp(ctx.redis)
        .then((up) =>
          cb(null, {
            status: "ok",
            redis: up ? "up" : "down",
            uptime_ms: Date.now() - ctx.startedAtMs,
          }),
        )
        .catch((err: unknown) => cb(toGrpcError(err)));
    },
  };
}

function toBatchEntry(entry: BatchEntry): GrpcBatchEntry {
  return "error" in entry ? { error: entry.error } : { decision: toResponse(entry.decision) };
}
