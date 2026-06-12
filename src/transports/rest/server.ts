import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import type { AppContext } from "../../app.js";
import { registerRoutes } from "./routes.js";
import { ServiceError } from "../../service/errors.js";

/**
 * REST transport (thin). Builds the Fastify instance, installs a central error
 * handler that maps typed ServiceErrors to HTTP statuses, and registers routes.
 * Business logic lives in the service layer.
 *
 * We hand Fastify pino *options* (not a pino instance) so it keeps the default
 * FastifyInstance type — passing a custom instance would specialise the logger
 * generic and break route/handler typing.
 */
export function buildRestServer(ctx: AppContext): FastifyInstance {
  const pretty = ctx.config.nodeEnv === "development";
  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      base: { service: "throttle", transport: "rest" },
      ...(pretty ? { transport: { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l" } } } : {}),
    },
    disableRequestLogging: true, // explicit per-check logging is added in M5
  });

  // Typed service errors -> their HTTP status; everything else -> 500.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ServiceError) {
      reply.code(err.httpStatus);
      return reply.send({ error: { code: err.code, message: err.message } });
    }
    ctx.logger.error({ err: err.message }, "unhandled error");
    reply.code(500);
    return reply.send({ error: { code: "INTERNAL", message: "internal error" } });
  });

  registerRoutes(app, ctx);
  return app;
}
