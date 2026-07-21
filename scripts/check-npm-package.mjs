import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = mkdtempSync(join(tmpdir(), "mikan-package-check-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  const packResult = JSON.parse(
    execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", tempDir], {
      cwd: rootDir,
      encoding: "utf8",
    }),
  )[0];
  if (packResult.files.some((file) => file.path.includes("agent-sandbox"))) {
    throw new Error("npm package must not contain Agent Sandbox files");
  }
  const tarball = join(tempDir, packResult.filename);
  const prefix = join(tempDir, "global");
  execFileSync(
    npm,
    ["install", "-g", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball],
    { stdio: "pipe" },
  );

  const globalRoot = execFileSync(npm, ["root", "-g", "--prefix", prefix], {
    encoding: "utf8",
  }).trim();
  const packageDir = join(globalRoot, "@geminixiang", "mikan");
  const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  for (const dependency of ["agentic-sandbox-client", "@kubernetes/client-node"]) {
    if (packageJson.dependencies?.[dependency]) {
      throw new Error(`npm package must not depend on ${dependency}`);
    }
  }
  const version = execFileSync(
    process.execPath,
    [join(packageDir, "dist", "main.js"), "--version"],
    {
      encoding: "utf8",
    },
  ).trim();
  if (version !== packageJson.version) {
    throw new Error(`packed CLI version mismatch: expected ${packageJson.version}, got ${version}`);
  }

  const sizeKiB = Math.ceil(statSync(tarball).size / 1024);
  if (sizeKiB > 2048) throw new Error(`npm package is unexpectedly large: ${sizeKiB} KiB`);
  console.log(`Verified global install of ${packResult.filename}: ${sizeKiB} KiB, CLI ${version}.`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
