import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

/**
 * One throwaway Redis for the whole suite. We test against a real server, not a
 * mock: the entire point is atomic Lua, ZSET semantics, and EVALSHA behavior,
 * none of which a fake reproduces faithfully. The connection URL reaches test
 * files via vitest's provide/inject.
 */
let container: StartedRedisContainer;

export default async function setup(project: TestProject) {
  container = await new RedisContainer("redis:7-alpine").start();
  project.provide("redisUrl", container.getConnectionUrl());

  return async () => {
    await container.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    redisUrl: string;
  }
}
