import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  resolve: {
    alias: {
      "@geminixiang/mikan": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    setupFiles: ["./src/test/setup/git-env.ts", "./src/test/setup/state-dir.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/test/**",
        "src/content/**",
        "src/content.config.ts",
        "src/types.ts",
        "src/main.ts",
        "src/cli/download.ts",
        "src/observability/instrument.ts",
        "src/adapters/web/admin/portal.ts",
        "src/adapters/web/session-view/portal.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 77,
        "src/{adapters/commands/utils,events/index,harness/tools/event,harness/tools/write}.ts": {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        "src/file-guards.ts": {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        "src/log.ts": {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        "src/{harness/tools/read,harness/tools/bash,sandbox/utils}.ts": {
          statements: 90,
          branches: 75,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
