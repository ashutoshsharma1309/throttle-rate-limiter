import { buildApp } from "./app.js";
import { buildRestServer } from "./transports/rest/server.js";
import { buildGrpcServer, startGrpcServer, stopGrpcServer } from "./transports/grpc/server.js";
import { waitForReady } from "./adapters/redis.js";

/**
 * Process entrypoint. Boots BOTH transports over the one shared core, then
 * installs graceful shutdown. Full in-flight draining is hardened in M5.
 */
async function main(): Promise<void> {
  const ctx = buildApp(Date.now());
  const { config, logger } = ctx;

  // Warm the Lua scripts so the first request is already EVALSHA-ready. Tolerate
  // Redis being down at boot — scripts load lazily on first use otherwise.
  try {
    await waitForReady(ctx.redis);
    await ctx.services.scripts.load();
    logger.info("lua scripts loaded");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "could not preload lua scripts; will load on demand");
  }

  const rest = buildRestServer(ctx);
  await rest.listen({ host: "0.0.0.0", port: config.httpPort });
  logger.info({ port: config.httpPort }, "REST transport listening");

  const grpc = buildGrpcServer(ctx);
  const grpcPort = await startGrpcServer(grpc, config.grpcPort);
  logger.info({ port: grpcPort }, "gRPC transport listening");

  // Graceful shutdown: stop accepting on both transports, drain in-flight
  // requests, then quit Redis. A hard deadline forces exit if a drain hangs.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    const deadline = setTimeout(() => {
      logger.warn("drain timed out; forcing shutdown");
      grpc.forceShutdown();
      process.exit(1);
    }, 10_000);
    deadline.unref();

    try {
      await Promise.all([rest.close(), stopGrpcServer(grpc)]); // both stop accepting + drain
      ctx.redis.disconnect();
      clearTimeout(deadline);
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "error during shutdown");
      process.exit(1);
    }
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}

main().catch((err) => {
  console.error("fatal: failed to start", err);
  process.exit(1);
});
