/**
 * Resolve a `mikan ext install` source that points at a git repository into a
 * local directory: clone it, descend into an optional `#subpath`, and run
 * `npm install --omit=dev` when the extension declares dependencies. The
 * caller validates + copies the returned directory, then calls cleanup().
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResolvedGitSource } from "./types.js";

export type { ResolvedGitSource } from "./types.js";

interface GitSpec {
  url: string;
  subpath?: string;
}

/**
 * Recognize a git source and split off an optional `#subpath`:
 *   https://host/owner/repo.git#dir/ext   → { url, subpath }
 *   git@host:owner/repo.git               → { url }
 *   github:owner/repo                     → expands to https clone URL
 * Returns undefined for anything that looks like a local path.
 */
export function parseGitSource(source: string): GitSpec | undefined {
  const [locator, subpath] = splitSubpath(source);

  if (locator.startsWith("github:")) {
    const repo = locator.slice("github:".length).replace(/\.git$/, "");
    return { url: `https://github.com/${repo}.git`, subpath };
  }
  if (
    locator.startsWith("https://") ||
    locator.startsWith("http://") ||
    locator.startsWith("git://") ||
    locator.startsWith("ssh://") ||
    locator.startsWith("file://") ||
    /^git@[^:]+:/.test(locator)
  ) {
    return { url: locator, subpath };
  }
  return undefined;
}

function splitSubpath(source: string): [string, string | undefined] {
  const hash = source.indexOf("#");
  if (hash === -1) return [source, undefined];
  const subpath = source.slice(hash + 1).trim();
  if (!subpath) return [source.slice(0, hash), undefined];
  assertSafeRelativePath(subpath);
  return [source.slice(0, hash), subpath];
}

function assertSafeRelativePath(value: string): void {
  if (
    isAbsolute(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new Error(`#subpath must be a relative path without '..': ${JSON.stringify(value)}`);
  }
}

function resolveSubpath(root: string, subpath: string): string {
  assertSafeRelativePath(subpath);
  const resolvedRoot = resolve(root);
  const dir = resolve(resolvedRoot, subpath);
  const relation = relative(resolvedRoot, dir);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`Subpath escapes repository: ${subpath}`);
  }
  return dir;
}

/** Clone a git source (shallow) and resolve the extension directory within it. */
export function resolveGitSource(spec: GitSpec): ResolvedGitSource {
  if (spec.subpath) assertSafeRelativePath(spec.subpath);
  const tempRoot = mkdtempSync(join(tmpdir(), "mikan-ext-git-"));
  const cleanup = () => rmSync(tempRoot, { recursive: true, force: true });
  try {
    execFileSync("git", ["clone", "--depth", "1", spec.url, tempRoot], { stdio: "inherit" });

    const dir = spec.subpath ? resolveSubpath(tempRoot, spec.subpath) : tempRoot;
    if (!existsSync(dir)) {
      throw new Error(`Subpath not found in repository: ${spec.subpath}`);
    }

    // Install runtime dependencies only when the extension declares any.
    if (hasDependencies(dir)) {
      execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
        cwd: dir,
        stdio: "inherit",
      });
    }
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function hasDependencies(dir: string): boolean {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies && Object.keys(pkg.dependencies).length > 0);
  } catch {
    return false;
  }
}
