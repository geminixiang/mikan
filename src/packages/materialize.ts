/**
 * Turning a parsed source into a directory on the host.
 *
 * Materialization is an explicit, reported step — it happens when a human adds
 * or updates a package, not lazily while a conversation is waiting for a
 * reply. Failures (bad URL, missing ref, no such subpath) therefore surface in
 * front of the person who typed the source instead of as a silently absent
 * feature in a chat.
 *
 * Everything lands under the host-only state dir, never the workspace: this
 * code is imported into the mikan process, so a mounted location would let
 * sandboxed code write what the host executes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDirExists, readTextFileIfExists } from "../utils/file-guards.js";
import * as log from "../log.js";
import { gitRepoPath, parseSource, sourceIdentity } from "./source.js";
import type {
  MaterializeOptions,
  MaterializedPackage,
  PackageScope,
  PackageSourceString,
  ParsedSource,
} from "./types.js";

export type { MaterializeOptions } from "./types.js";

/** Git operations get a bounded wall clock so a hung remote cannot wedge a save. */
const GIT_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 300_000;

/**
 * How far materialization may go to produce the package's files.
 *
 * - `offline`: use what is already on disk; never touch the network. This is
 *   what a conversation load uses, so no chat reply can ever wait on a remote.
 * - `fetch`: clone a package that is not on disk yet, but leave an existing
 *   clone where it is. What the portal uses when a source is added.
 * - `refresh`: additionally re-fetch an existing clone, resetting and cleaning
 *   it first. What the portal's Update action uses.
 *
 * One mode rather than two booleans: "re-fetch an existing clone but refuse to
 * create a missing one" is not a state any caller wants, and expressing it
 * should not be possible.
 */
/**
 * Root of a scope's host-only assets: `<stateDir>/global` or
 * `<stateDir>/conversations/<id>`. The two are isomorphic by design — both
 * hold `extensions/`, `extension-data/`, and now `git/`. See
 * `src/harness/extensions/LAYOUT.md`.
 */
export function packageScopeDir(
  scope: PackageScope,
  conversationId: string | undefined,
  stateDir: string,
): string {
  if (scope === "global") return join(stateDir, "global");
  if (!conversationId) throw new Error("A conversation-scoped package needs a conversation id");
  assertSafePathSegment(conversationId);
  return join(stateDir, "conversations", conversationId);
}

/** Where a git package's clone lives: `<scope>/git/<host>/<owner>/<repo>`. */
export function gitCloneDir(url: string, scopeDir: string): string {
  return join(scopeDir, "git", ...gitRepoPath(url).split("/"));
}

/**
 * Materialize one source and return where its files ended up. Throws with a
 * message meant to be shown to a human — callers render it next to the input
 * that produced it.
 */
export function materializeSource(
  source: PackageSourceString,
  options: MaterializeOptions,
): MaterializedPackage {
  const parsed = parseSource(source);
  const scopeDir = packageScopeDir(options.scope, options.conversationId, options.stateDir);
  const dir =
    parsed.type === "local"
      ? materializeLocal(parsed)
      : materializeGit(parsed, scopeDir, options.mode ?? "fetch");

  return {
    source,
    parsed,
    identity: sourceIdentity(parsed),
    dir,
    scope: options.scope,
  };
}

function materializeLocal(parsed: Extract<ParsedSource, { type: "local" }>): string {
  if (!existsSync(parsed.path)) {
    throw new Error(`Path does not exist on the mikan host: ${parsed.path}`);
  }
  if (!statSync(parsed.path).isDirectory()) {
    throw new Error(`Package path must be a directory: ${parsed.path}`);
  }
  return parsed.path;
}

function materializeGit(
  parsed: Extract<ParsedSource, { type: "git" }>,
  scopeDir: string,
  mode: MaterializeMode,
): string {
  const cloneDir = gitCloneDir(parsed.url, scopeDir);
  const alreadyCloned = existsSync(join(cloneDir, ".git"));

  if (alreadyCloned && mode !== "refresh") {
    return resolveSubpath(cloneDir, parsed);
  }
  if (!alreadyCloned && mode === "offline") {
    throw new Error(`Not fetched on this host yet: ${describeRef(parsed)}`);
  }

  if (!alreadyCloned) {
    // A leftover directory without .git means a previous attempt died partway.
    if (existsSync(cloneDir)) rmSync(cloneDir, { recursive: true, force: true });
    ensureDirExists(cloneDir);
    git(cloneDir, ["init", "-q"]);
    git(cloneDir, ["remote", "add", "origin", parsed.url]);
  } else {
    // Reconcile: drop anything a previous checkout left behind so the new ref
    // lands on a clean tree.
    git(cloneDir, ["remote", "set-url", "origin", parsed.url]);
    git(cloneDir, ["reset", "--hard", "-q"]);
    git(cloneDir, ["clean", "-qfd"]);
  }

  // One fetch shape for every kind of ref — tag, branch, or commit sha — and
  // `HEAD` for "whatever the remote's default branch is now".
  const ref = parsed.ref ?? "HEAD";
  try {
    git(cloneDir, ["fetch", "--depth", "1", "origin", ref]);
  } catch (err) {
    if (!alreadyCloned) rmSync(cloneDir, { recursive: true, force: true });
    throw new Error(`Could not fetch ${describeRef(parsed)}: ${gitErrorText(err)}`, { cause: err });
  }
  git(cloneDir, ["checkout", "-q", "--detach", "FETCH_HEAD"]);

  const dir = resolveSubpath(cloneDir, parsed);
  installDependencies(dir);
  return dir;
}

function resolveSubpath(cloneDir: string, parsed: Extract<ParsedSource, { type: "git" }>): string {
  if (!parsed.subpath) return cloneDir;
  const dir = join(cloneDir, parsed.subpath);
  if (!existsSync(dir)) {
    throw new Error(`Subpath not found in repository: ${parsed.subpath}`);
  }
  return dir;
}

/**
 * Install runtime dependencies when the package declares any. This runs npm
 * on the host against code that was just fetched from a remote, which is the
 * same trust level as importing the package itself — but it is worth being
 * explicit that it happens, because it also runs the dependencies' install
 * scripts.
 */
function installDependencies(dir: string): void {
  if (!hasDependencies(dir)) return;
  log.logInfo(`Installing package dependencies in ${dir}`);
  try {
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: dir,
      timeout: NPM_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`npm install failed for the package: ${gitErrorText(err)}`, { cause: err });
  }
}

function hasDependencies(dir: string): boolean {
  const raw = readTextFileIfExists(join(dir, "package.json"));
  if (raw === undefined) return false;
  try {
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return Boolean(pkg.dependencies && Object.keys(pkg.dependencies).length > 0);
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Never block a portal save on an interactive credential prompt.
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
    },
  });
}

function describeRef(parsed: Extract<ParsedSource, { type: "git" }>): string {
  return parsed.ref ? `${parsed.url} at ${parsed.ref}` : parsed.url;
}

/** Prefer git's stderr over the generic "Command failed" wrapper. */
function gitErrorText(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" ? stderr.trim() : "";
    if (text) return text.split("\n").slice(-3).join(" ");
  }
  return err instanceof Error ? err.message : String(err);
}

function assertSafePathSegment(value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("Conversation id must be a safe path segment");
  }
}
