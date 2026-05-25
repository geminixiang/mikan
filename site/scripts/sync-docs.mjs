#!/usr/bin/env node
// Sync ../docs/*.md (and ../docs/oauth/*.md, ../docs/assets/) into
// site/src/content/docs/ so that Starlight's docsLoader can pick them up,
// while keeping the canonical sources next to the project README.
//
// Layout assumed:
//   mikan/
//   ├── docs/        ← canonical markdown (committed)
//   └── site/        ← this Astro project; runs `sync-docs` before dev/build
//
// Run automatically before `astro dev` and `astro build` via package.json.

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, "..");
const projectRoot = resolve(siteRoot, "..");
const docsRoot = join(projectRoot, "docs");
const contentDir = join(siteRoot, "src", "content", "docs");
const publicAssetsDir = join(siteRoot, "public", "docs-assets");

const KEEP_IN_CONTENT = new Set(["index.mdx", "install.mdx"]);

async function clean() {
  const entries = await readdir(contentDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (KEEP_IN_CONTENT.has(entry.name)) return;
      await rm(join(contentDir, entry.name), { recursive: true, force: true });
    }),
  );
}

async function copyMarkdown() {
  const entries = await readdir(docsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      await cp(join(docsRoot, entry.name), join(contentDir, entry.name));
    }
    if (entry.isDirectory() && entry.name === "oauth") {
      const dest = join(contentDir, "oauth");
      await mkdir(dest, { recursive: true });
      const subs = await readdir(join(docsRoot, "oauth"));
      for (const sub of subs) {
        if (sub.endsWith(".md")) {
          await cp(join(docsRoot, "oauth", sub), join(dest, sub));
        }
      }
    }
  }
}

async function copyAssets() {
  const src = join(docsRoot, "assets");
  try {
    await stat(src);
  } catch {
    return;
  }
  await rm(publicAssetsDir, { recursive: true, force: true });
  await mkdir(publicAssetsDir, { recursive: true });
  await cp(src, publicAssetsDir, { recursive: true });
}

await mkdir(contentDir, { recursive: true });
await clean();
await copyMarkdown();
await copyAssets();
console.log("[sync-docs] synced ../docs/*.md -> src/content/docs/");
