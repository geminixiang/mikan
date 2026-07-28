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
import { createHash } from "node:crypto";
import { cpSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDirExists, readTextFileIfExists } from "../utils/file-guards.js";
import * as log from "../log.js";
import { gitRepoPath, parseSource, sourceIdentity } from "./source.js";
import { officeStateDir } from "../office-address.js";
import type { OfficeAddress } from "../types.js";
import type {
  MaterializeMode,
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
const MATERIALIZED_REF_FILE = "mikan-ref";

/**
 * How far materialization may go to produce the package's files.
 *
 * - `offline`: use what is already on disk; never touch the network. This is
 *   what a conversation load uses, so no chat reply can ever wait on a remote.
 * - `fetch`: clone a package that is not on disk yet, reuse an existing clone
 *   when it already has the requested ref, or switch it to a new ref. What the
 *   portal uses when a source is added.
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
  address: OfficeAddress | undefined,
  stateDir: string,
): string {
  if (scope === "global") return join(stateDir, "global");
  if (!address) throw new Error("A conversation-scoped package needs an office address");
  return officeStateDir(stateDir, address);
}

/**
 * Where a git checkout lives.
 *
 * The unpinned checkout keeps the original path for compatibility. Explicit
 * refs get a sibling keyed by the ref, so two refs can never reset each
 * other's working tree; subpaths of one ref therefore still share a checkout.
 */
export function gitCloneDir(url: string, scopeDir: string, ref?: string): string {
  const repoPath = gitRepoPath(url).split("/");
  const repoName = repoPath[repoPath.length - 1];
  const parent = repoPath.slice(0, -1);
  const checkoutName =
    ref === undefined || ref === "HEAD"
      ? repoName
      : `${repoName}.mikan-${createHash("sha256").update(ref).digest("hex")}`;
  return join(scopeDir, "git", ...parent, checkoutName);
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
  const scopeDir = packageScopeDir(options.scope, options.address, options.stateDir);
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
  const requestedRef = parsed.ref ?? "HEAD";
  const cloneDir = gitCloneDir(parsed.url, scopeDir, requestedRef);
  migrateLegacyCheckout(parsed.url, scopeDir, cloneDir, requestedRef);
  const alreadyCloned = existsSync(join(cloneDir, ".git"));
  const markerPath = join(cloneDir, ".git", MATERIALIZED_REF_FILE);
  const recordedRef = alreadyCloned ? readTextFileIfExists(markerPath)?.trim() : undefined;
  const canReuse =
    alreadyCloned &&
    mode !== "refresh" &&
    (recordedRef === requestedRef ||
      (mode === "offline" &&
        recordedRef === undefined &&
        markerlessCheckoutMatchesRef(cloneDir, requestedRef)));

  if (canReuse) {
    return resolveSubpath(cloneDir, parsed);
  }
  if (mode === "offline") {
    throw new Error(`Not fetched on this host yet: ${describeRef(parsed)}`);
  }

  // An incomplete checkout must not retain a marker from an earlier attempt:
  // otherwise a retry could mistake a failed dependency install for success.
  if (alreadyCloned) rmSync(markerPath, { force: true });

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
  try {
    git(cloneDir, ["fetch", "--depth", "1", "origin", requestedRef]);
  } catch (err) {
    if (!alreadyCloned) rmSync(cloneDir, { recursive: true, force: true });
    throw new Error(`Could not fetch ${describeRef(parsed)}: ${gitErrorText(err)}`, { cause: err });
  }
  git(cloneDir, ["checkout", "-q", "--detach", "FETCH_HEAD"]);

  const dir = resolveSubpath(cloneDir, parsed);
  installDependencies(dir);
  // This is the completion marker, not merely a fetched-ref marker. Write it
  // last so a failed npm install is retried by the next materialization.
  writeFileSync(markerPath, `${requestedRef}\n`);
  return dir;
}

/**
 * Before keyed checkout paths existed, every ref used the legacy repo path.
 * Copy a matching complete checkout on first use of its keyed path so offline
 * loads keep working. Markerless legacy checkouts are accepted only when git
 * can prove the requested ref is the checked-out commit; a different or
 * unprovable pinned ref is rebuilt by fetch/refresh instead.
 */
function migrateLegacyCheckout(
  url: string,
  scopeDir: string,
  cloneDir: string,
  requestedRef: string,
): void {
  const legacyDir = gitCloneDir(url, scopeDir);
  if (cloneDir === legacyDir || existsSync(cloneDir)) return;
  const legacyMarker = join(legacyDir, ".git", MATERIALIZED_REF_FILE);
  if (!existsSync(join(legacyDir, ".git"))) return;
  const recordedRef = readTextFileIfExists(legacyMarker)?.trim();
  if (recordedRef !== requestedRef) {
    if (recordedRef !== undefined || !markerlessCheckoutMatchesRef(legacyDir, requestedRef)) {
      return;
    }
  }

  ensureDirExists(dirname(cloneDir));
  cpSync(legacyDir, cloneDir, { recursive: true });
}

/**
 * Legacy checkouts have no completion marker. Accept them offline only when
 * the checkout is clean and the local git metadata identifies the requested
 * commit/ref; never infer a pinned ref from HEAD alone.
 */
function markerlessCheckoutMatchesRef(cloneDir: string, requestedRef: string): boolean {
  let head: string;
  try {
    head = git(cloneDir, ["rev-parse", "--verify", "HEAD"]).trim();
    if (!head || git(cloneDir, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
      return false;
    }
  } catch {
    return false;
  }

  if (requestedRef === "HEAD") return true;

  try {
    if (git(cloneDir, ["rev-parse", "--verify", `${requestedRef}^{commit}`]).trim() === head) {
      return true;
    }
  } catch {
    // A shallow legacy fetch may retain only FETCH_HEAD, not a local ref.
  }

  try {
    if (git(cloneDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim() === requestedRef) {
      return true;
    }
  } catch {
    // Detached checkouts do not have a symbolic branch.
  }

  const fetchHead = readTextFileIfExists(join(cloneDir, ".git", "FETCH_HEAD"));
  if (!fetchHead) return false;
  return fetchHead.split("\n").some((line) => {
    const match = /^(\w+)\s+.*(?:branch|tag) '([^']+)'/.exec(line);
    return match?.[1] === head && match[2] === requestedRef;
  });
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
