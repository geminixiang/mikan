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
      include: ["src/**/*.ts"],
      exclude: [
        // Starlight docs content, not runtime code
        "src/content/**",
        "src/content.config.ts",
        // Type-only / entrypoint wiring with no unit-testable surface
        "src/types.ts",
        "src/main.ts",
        "src/cli/download.ts",
        "src/observability/instrument.ts",
        // Dominated by server-rendered HTML/JS template strings; covered
        // behavior lives in the sibling service/store modules
        "src/web/admin/portal.ts",
        "src/web/session-view/portal.ts",
      ],
      thresholds: {
        // Global ratchet: set just below current actuals so coverage can only
        // move up. Raise these as under-tested areas gain tests.
        statements: 72,
        branches: 62,
        functions: 72,
        lines: 73,
        // Files that already meet a high bar stay held to it.
        "src/{commands/auto-reply,commands/utils,sessions/metadata,tools/event,tools/truncate,tools/write}.ts":
          {
            statements: 95,
            branches: 90,
            functions: 95,
            lines: 95,
          },
        "src/utils/{date,env,file-guards,fs-atomic,html}.ts": {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        "src/{store,tools/read,tools/bash,sandbox/utils}.ts": {
          statements: 90,
          branches: 75,
          functions: 90,
          lines: 90,
        },
      },
    },
  },
});
