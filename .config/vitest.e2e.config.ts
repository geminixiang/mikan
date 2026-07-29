import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    pool: "forks",
    forks: { singleFork: true },
    reporters: ["verbose"],
  },
});
