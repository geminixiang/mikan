import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Lets examples/ (and tests exercising them) import the public npm
      // surface by name while running against the in-repo sources.
      "@geminixiang/mikan": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/commands/auto-reply.ts",
        "src/commands/utils.ts",
        "src/sessions/metadata.ts",
        "src/tools/event.ts",
        "src/tools/truncate.ts",
        "src/tools/write.ts",
        "src/utils/date.ts",
        "src/utils/env.ts",
        "src/utils/file-guards.ts",
        "src/utils/fs-atomic.ts",
        "src/utils/html.ts",
      ],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
