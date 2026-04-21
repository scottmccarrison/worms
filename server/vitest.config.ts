import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    isolate: false,
    // Integration tests need a little longer than the 5s default when
    // the matchMaker + presence layer warms up on the first room.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
