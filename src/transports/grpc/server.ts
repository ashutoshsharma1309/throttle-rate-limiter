import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { AppContext } from "../../app.js";
import { makeHandlers } from "./handlers.js";

/**
 * gRPC transport (thin). Loads the proto, registers the shared handlers, and
 * exposes bind/shutdown. proto/ sits at the repo root and is copied next to
 * dist/ in the image; resolving relative to import.meta.url works in both
 * (src/ under tsx and dist/ compiled) since both are one level below root.
 */
const PROTO_PATH = fileURLToPath(new URL("../../../proto/throttle.proto", import.meta.url));

function loadServiceDef(): grpc.ServiceDefinition {
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
  return loaded.throttle.v1.RateLimiter.service;
}

export function buildGrpcServer(ctx: AppContext): grpc.Server {
  const server = new grpc.Server();
  server.addService(loadServiceDef(), makeHandlers(ctx));
  return server;
}

/** Bind + start. Resolves with the actual bound port. */
export function startGrpcServer(server: grpc.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });
}

/** Graceful drain: stop accepting, let in-flight RPCs finish. */
export function stopGrpcServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()));
}
