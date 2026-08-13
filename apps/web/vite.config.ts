import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Workspace packages resolve to SOURCE so CSS and TSX ride Vite's pipeline
 * (DSH pattern: the shell packages are aliased to src, never pre-built).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@geminixiang\/mikan-web-client$/,
        replacement: src("../../packages/web-client/src/index.ts"),
      },
      {
        find: /^@geminixiang\/mikan-ui-session$/,
        replacement: src("../../packages/ui-session/src/index.ts"),
      },
      {
        find: /^@geminixiang\/mikan-ui-admin$/,
        replacement: src("../../packages/ui-admin/src/index.ts"),
      },
      {
        find: /^@geminixiang\/mikan-ui-vault$/,
        replacement: src("../../packages/ui-vault/src/index.ts"),
      },
    ],
  },
  build: {
    sourcemap: true,
  },
});
