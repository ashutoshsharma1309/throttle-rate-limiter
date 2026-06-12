import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../../app.js";
import { redisIsUp } from "../../adapters/redis.js";
import { applyRateLimitHeaders, checkBody } from "./headers.js";
import { parseCost } from "../../service/validation.js";
import { AdminForbiddenError, InvalidRequestError } from "../../service/errors.js";
import type { BatchEntry, BatchItem } from "../../service/rateLimitService.js";

function apiKeyOf(req: FastifyRequest): string {
  const h = req.headers["x-api-key"];
  return typeof h === "string" ? h : "";
}

function requireAdmin(ctx: AppContext, req: FastifyRequest): void {
  if (apiKeyOf(req) !== ctx.config.adminApiKey) throw new AdminForbiddenError();
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new InvalidRequestError(`${name} must be a non-empty string`);
  }
  return v;
}

/** Register all REST routes. Routes are thin: parse -> service -> shape reply. */
export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { rateLimit, admin } = ctx.services;

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/v1/health", async () => ({
    status: "ok",
    redis: (await redisIsUp(ctx.redis)) ? "up" : "down",
    uptimeMs: Date.now() - ctx.startedAtMs,
  }));

  // ── Metrics (Prometheus text format) ────────────────────────────────────────
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", "text/plain; version=0.0.4");
    return ctx.services.metrics.render();
  });

  // ── Check ─────────────────────────────────────────────────────────────────
  app.post("/v1/check", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = await rateLimit.check({
      apiKey: apiKeyOf(req),
      rule: str(body.rule, "rule"),
      identifier: str(body.identifier, "identifier"),
      ...(parseCost(body.cost) !== undefined ? { cost: parseCost(body.cost) } : {}),
    });
    applyRateLimitHeaders(reply, decision);
    reply.code(decision.allowed ? 200 : 429);
    return checkBody(decision);
  });

  // ── Batch check ─────────────────────────────────────────────────────────────
  app.post("/v1/check/batch", async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!Array.isArray(body.checks)) {
      throw new InvalidRequestError("checks must be an array");
    }
    const items: BatchItem[] = body.checks.map((c: unknown) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return {
        rule: str(o.rule, "rule"),
        identifier: str(o.identifier, "identifier"),
        ...(parseCost(o.cost) !== undefined ? { cost: parseCost(o.cost) } : {}),
      };
    });
    const entries = await rateLimit.checkBatch(apiKeyOf(req), items);
    return { results: entries.map(formatBatchEntry) };
  });

  // ── Admin: tenants & rules ──────────────────────────────────────────────────
  app.post("/v1/admin/tenants", async (req, reply) => {
    requireAdmin(ctx, req);
    const created = await admin.createTenant();
    reply.code(201);
    return created; // { tenantId, apiKey } — apiKey shown once
  });

  app.put<{ Params: { id: string; ruleId: string } }>(
    "/v1/admin/tenants/:id/rules/:ruleId",
    async (req, reply) => {
      requireAdmin(ctx, req);
      const rule = await admin.putRule(req.params.id, req.params.ruleId, req.body);
      reply.code(200);
      return { rule };
    },
  );

  app.get<{ Params: { id: string } }>("/v1/admin/tenants/:id/rules", async (req) => {
    requireAdmin(ctx, req);
    return { rules: await admin.listRules(req.params.id) };
  });

  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/v1/admin/tenants/:id/rules/:ruleId",
    async (req, reply) => {
      requireAdmin(ctx, req);
      const removed = await admin.deleteRule(req.params.id, req.params.ruleId);
      reply.code(removed ? 204 : 404);
      return removed ? null : { error: { code: "UNKNOWN_RULE", message: "no such rule" } };
    },
  );
}

/** Flatten a batch entry for the wire (both resetMs and retryAfterMs, since
 *  per-item headers aren't available). */
function formatBatchEntry(entry: BatchEntry): Record<string, unknown> {
  if ("error" in entry) return { error: entry.error };
  const d = entry.decision;
  return {
    allowed: d.allowed,
    remaining: Math.max(0, d.remaining),
    limit: d.limit,
    resetMs: d.resetMs,
    retryAfterMs: d.retryAfterMs,
  };
}
