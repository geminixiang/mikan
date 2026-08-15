import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = (relativePath: string): string => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@geminixiang\/mikan-web-client$/,
        replacement: src("../../packages/web-client/src/index.ts"),
      },
      {
        find: /^@geminixiang\/mikan-harness-web-contract$/,
        replacement: src("../../packages/harness-web-contract/src/index.ts"),
      },
    ],
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8181", changeOrigin: true },
      "/binding": { target: "http://127.0.0.1:8181", changeOrigin: true },
      "/session": { target: "http://127.0.0.1:8181", changeOrigin: true },
      "/admin": { target: "http://127.0.0.1:8181", changeOrigin: true },
      "/link": { target: "http://127.0.0.1:8181", changeOrigin: true },
      "/oauth": { target: "http://127.0.0.1:8181", changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
  },
});
