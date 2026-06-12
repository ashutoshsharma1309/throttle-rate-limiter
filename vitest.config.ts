import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    // Testcontainers may pull the Redis image on first run.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One shared Redis container; run test files serially so the concurrency
    // test owns its keyspace without interference from other files.
    fileParallelism: false,
  },
});
