/**
 * Embed the compiled web seam packages into the daemon's dist/ so the
 * published npm artifact stays self-contained.
 *
 * The daemon (src/) imports @geminixiang/mikan-web-host and
 * @geminixiang/mikan-web-bundle at runtime. Those packages are private
 * workspace packages, so a fresh `npm install -g <tarball>` cannot resolve
 * them from the registry. This step copies their tsgo output (lib/) into
 * dist/.internal/<name> and rewrites the import specifiers in the emitted
 * dist files to relative paths — the npm-published daemon then needs nothing
 * outside its own dist/. (The workspace packages remain the single source of
 * truth; this only embeds their build output, like a tiny inlining step.)
 *
 * Run after `tsgo -p src/tsconfig.build.json` in the root build.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, "dist");
const embedDir = join(distDir, ".internal");

/** Workspace package name -> its package dir (lib/ compiled by tsgo). */
const PACKAGES = new Map([
  ["@geminixiang/mikan-daemon-web-bridge", "daemon-web-bridge"],
  ["@geminixiang/mikan-sandbox-cloudflare", "sandbox-cloudflare"],
  ["@geminixiang/mikan-sandbox-container", "sandbox-container"],
  ["@geminixiang/mikan-sandbox-contract", "sandbox-contract"],
  ["@geminixiang/mikan-sandbox-firecracker", "sandbox-firecracker"],
  ["@geminixiang/mikan-sandbox-host", "sandbox-host"],
  ["@geminixiang/mikan-sandbox-image", "sandbox-image"],
  ["@geminixiang/mikan-web-host", "web-host"],
  ["@geminixiang/mikan-web-bundle", "web-bundle"],
]);

// 1. Copy each package's tsgo output into dist/.internal/<dir>.
rmSync(embedDir, { recursive: true, force: true });
mkdirSync(embedDir, { recursive: true });
for (const packageDir of PACKAGES.values()) {
  cpSync(join(rootDir, "packages", packageDir, "lib"), join(embedDir, packageDir), {
    recursive: true,
  });
}

// 2. Rewrite `from "<spec>"` to a relative path in every emitted JS/d.ts file
// (the copied lib files too, so a package importing a sibling resolves).
const FILE_RE = /\.(?:js|d\.ts)$/;

function rewriteSpecifiers(file) {
  let text = readFileSync(file, "utf8");
  let changed = false;
  for (const [spec, packageDir] of PACKAGES) {
    const target = join(embedDir, packageDir, "index.js");
    let rel = relative(dirname(file), target);
    // A leading "." without "/" (e.g. ".internal/...") is not a valid ESM
    // relative specifier — normalize to "./".
    if (!rel.startsWith("./") && !rel.startsWith("../")) rel = `./${rel}`;
    const patched = text.replaceAll(`"${spec}"`, `"${rel}"`);
    if (patched !== text) {
      text = patched;
      changed = true;
    }
  }
  if (changed) writeFileSync(file, text);
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (FILE_RE.test(entry.name)) rewriteSpecifiers(full);
  }
}

walk(distDir);
console.log(`Embedded ${PACKAGES.size} web seam packages into ${embedDir}`);
