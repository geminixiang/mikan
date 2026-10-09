import { defineConfig } from "vitest/config";

const repo = process.env.MIKAN_REPO;
if (!repo) throw new Error("Set MIKAN_REPO to the checkout under evaluation");

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "@mikan": `${repo}/src` } },
  test: {
    include: ["*.eval.ts"],
    testTimeout: 120_000,
    sequence: { shuffle: false },
    fileParallelism: false,
  },
});
