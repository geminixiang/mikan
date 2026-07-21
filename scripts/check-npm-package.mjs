import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  if (!packResult.bundled?.includes("agentic-sandbox-client")) {
    throw new Error("agentic-sandbox-client is missing from the npm bundle");
  }

  const tarball = join(tempDir, packResult.filename);
  const installDir = join(tempDir, "install");
  execFileSync(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDir, tarball],
    { stdio: "pipe" },
  );

  const packageDir = join(installDir, "node_modules", "@geminixiang", "mikan");
  const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const sdkEntry = join(packageDir, "node_modules", "agentic-sandbox-client", "dist", "index.js");
  if (!existsSync(sdkEntry)) throw new Error("bundled Agent Sandbox SDK entry point is missing");
  await import(pathToFileURL(sdkEntry).href);

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
  console.log(
    `Verified ${packResult.filename}: ${sizeKiB} KiB, bundled SDK, install, import, and CLI.`,
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
