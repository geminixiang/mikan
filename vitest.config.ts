import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "packages/mikan/src/commands/auto-reply.ts",
        "packages/mikan/src/utils/file-guards.ts",
        "packages/mikan/src/tools/event.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 85,
        functions: 95,
        lines: 95,
      },
    },
  },
});
