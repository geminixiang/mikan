import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFileIfExists } from "./file-guards.js";
import { isRecord } from "./unknown-values.js";

export function packageVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const possiblePaths = [
    join(moduleDir, "package.json"),
    join(dirname(moduleDir), "package.json"),
    join(process.cwd(), "package.json"),
  ];

  for (const pkgPath of possiblePaths) {
    const pkg = readJsonFileIfExists(
      pkgPath,
      (value): value is { version?: unknown } => isRecord(value),
      () => "Ignoring package.json while resolving version",
    );
    if (typeof pkg?.version === "string" && pkg.version) return pkg.version;
  }
  return "unknown";
}
