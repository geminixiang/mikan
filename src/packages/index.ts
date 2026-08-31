/**
 * The packages module in one file: the package source grammar, git/local
 * materialization, inspection, conversation-scope resolution with skill
 * mounts, and the admin add/refresh/remove operations. Exported types live
 * in `types.ts`.
 */
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  MaterializeMode,
  MaterializeOptions,
  MaterializedPackage,
  PackageAdminContext,
  PackageError,
  PackageIdentity,
  PackageInventory,
  PackageScope,
  PackageSkillDir,
  PackageSourceString,
  PackageStatus,
  PackageWriteResult,
  ParsedSource,
  ResolvePackagesOptions,
  ResolvedPackages,
} from "./types.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { ensureDirExists, readTextFileIfExists } from "../utils/file-guards.js";
import * as log from "../log.js";
import { officeStateDir } from "../office/index.js";
import type { OfficeAddress } from "../types.js";
import { loadSkillsFromDir } from "../harness/index.js";
import { loadGlobalSettings, resolveConversationSettings } from "../config.js";
import { applyConversationSettings, applyGlobalSettings } from "../settings-mutation.js";

// ── Package source grammar ────────────────────────────────────────────────────

/**
 * The package source grammar: one place that turns a human-written source
 * string into a {@link ParsedSource}, and one place that decides when two
 * sources are the same package ({@link sourceIdentity}).
 *
 * Only git and local-path sources are implemented. The tagged union and the
 * identity function are the seams a future `npm:` source slots into: adding it
 * means a new arm here and a new materializer, with nothing downstream —
 * resolution, scope precedence, the portal — needing to know.
 *
 * Grammar:
 *
 *   <locator>[@<ref>][#<subpath>]
 *
 *   locator: https://…  http://…  ssh://…  git://…  file://…
 *            git@host:owner/repo
 *            git:<any of the above, or host/owner/repo shorthand>
 *            github:owner/repo
 *            /abs/path  ./rel/path        (local, used by reference)
 *
 * `@<ref>` is recognized only when what follows the last `@` contains no `/`
 * and no `:` — otherwise the `@` belongs to the URL's authority
 * (`git@github.com:…`). A consequence: refs containing a slash
 * (`release/1.0`) cannot be written in the string form; pin to a tag or a
 * commit sha instead. The admin portal takes the URL and the ref as separate
 * inputs and assembles a canonical string, so this only constrains
 * hand-edited settings.
 */

const PROTOCOL_PREFIXES = ["https://", "http://", "ssh://", "git://", "file://"];
const SCP_LIKE = /^[^@/\s]+@[^:/\s]+:/;

/**
 * Parse a source string. Throws with a user-facing message rather than
 * returning undefined: every caller (portal, settings load, CLI) needs to tell
 * the human what was wrong with what they typed.
 */
export function parseSource(source: string): ParsedSource {
  const trimmed = source.trim();
  if (!trimmed) throw new Error("Package source is empty");

  const { rest: withoutSubpath, subpath } = splitSubpath(trimmed);
  const { rest: locator, ref } = splitRef(withoutSubpath);

  if (locator.startsWith("github:")) {
    const repo = stripGitSuffix(locator.slice("github:".length).replace(/^\/+/, ""));
    if (!repo.includes("/")) {
      throw new Error(`github: source must be owner/repo, got ${JSON.stringify(locator)}`);
    }
    return gitSource(`https://github.com/${repo}.git`, ref, subpath);
  }

  if (locator.startsWith("git:")) {
    const inner = locator.slice("git:".length);
    if (isProtocolUrl(inner) || SCP_LIKE.test(inner)) return gitSource(inner, ref, subpath);
    // Shorthand: host/owner/repo — only meaningful with the git: prefix,
    // since bare host/owner/repo is ambiguous with a relative path.
    if (!inner.includes("/")) {
      throw new Error(`git: source must include a path, got ${JSON.stringify(locator)}`);
    }
    return gitSource(`https://${stripGitSuffix(inner)}.git`, ref, subpath);
  }

  if (isProtocolUrl(locator) || SCP_LIKE.test(locator)) return gitSource(locator, ref, subpath);

  if (isAbsolute(locator) || locator.startsWith("./") || locator.startsWith("../")) {
    if (ref) throw new Error("A local path source cannot carry an @ref");
    if (subpath) throw new Error("A local path source cannot carry a #subpath");
    return { type: "local", path: resolve(locator) };
  }

  throw new Error(
    `Unrecognized package source ${JSON.stringify(source)}. ` +
      "Use a git URL, github:owner/repo, git:host/owner/repo, or an absolute/relative path.",
  );
}

function gitSource(
  url: string,
  ref: string | undefined,
  subpath: string | undefined,
): ParsedSource {
  return { type: "git", url, ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}) };
}

function isProtocolUrl(value: string): boolean {
  return PROTOCOL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/, "").replace(/\/+$/, "");
}

function splitSubpath(source: string): { rest: string; subpath?: string } {
  const hash = source.indexOf("#");
  if (hash === -1) return { rest: source };
  const subpath = source.slice(hash + 1).trim();
  if (!subpath) return { rest: source.slice(0, hash) };
  assertSafeRelativePath(subpath, "#subpath");
  return { rest: source.slice(0, hash), subpath };
}

/**
 * Split a trailing `@ref`. The `@` in `git@github.com:owner/repo` is part of
 * the authority, not a ref, so a candidate only counts when its suffix looks
 * like a bare ref (no `/`, no `:`).
 */
function splitRef(source: string): { rest: string; ref?: string } {
  const at = source.lastIndexOf("@");
  if (at <= 0) return { rest: source };
  const candidate = source.slice(at + 1);
  if (!candidate || candidate.includes("/") || candidate.includes(":")) return { rest: source };
  return { rest: source.slice(0, at), ref: candidate };
}

/** Reject traversal and absolute escapes in the parts that become paths. */
function assertSafeRelativePath(value: string, label: string): void {
  if (isAbsolute(value) || value.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error(`${label} must be a relative path without '..': ${JSON.stringify(value)}`);
  }
}

/**
 * Identity of the package a source refers to — the key for deduplication and
 * for letting a conversation's copy shadow the global one.
 *
 * Deliberate choices:
 * - The ref is excluded: the same repo pinned to two refs in two scopes is one
 *   package installed twice, and the narrower scope wins.
 * - The subpath is included: two skill packages living at different paths in one
 *   monorepo are two packages.
 * - Transport is excluded: `git@github.com:o/r`, `https://github.com/o/r.git`
 *   and `ssh://git@github.com/o/r` all identify the same package, so mixing
 *   SSH and HTTPS spellings across scopes still dedups.
 */
export function sourceIdentity(parsed: ParsedSource): PackageIdentity {
  if (parsed.type === "local") return `local:${parsed.path}`;
  const repo = gitRepoPath(parsed.url);
  return parsed.subpath ? `git:${repo}#${parsed.subpath}` : `git:${repo}`;
}

/**
 * Transport-independent `<host>/<path>` of a git URL, lowercased host, no
 * `.git` suffix, no credentials. It is the base of the on-disk clone layout,
 * so it must stay free of anything that is not a safe path segment.
 */
export function gitRepoPath(url: string): string {
  let remainder = url;
  for (const prefix of PROTOCOL_PREFIXES) {
    if (remainder.startsWith(prefix)) {
      remainder = remainder.slice(prefix.length);
      break;
    }
  }
  // Drop any credentials in the authority (`user:pass@host`, `git@host`).
  const scpMatch = /^([^@/\s]+@)?([^:/\s]+)[:/](.+)$/.exec(remainder);
  if (!scpMatch) return sanitizeRepoPath(stripGitSuffix(remainder));
  const host = (scpMatch[2] ?? "").toLowerCase();
  const path = stripGitSuffix((scpMatch[3] ?? "").replace(/^\/+/, ""));
  return sanitizeRepoPath(`${host}/${path}`);
}

/**
 * `file://` URLs used in tests and local mirrors have no host, so the repo path
 * is an absolute filesystem path. Keep every segment filesystem-safe and drop
 * traversal, since this string becomes a directory under the state dir.
 */
function sanitizeRepoPath(value: string): string {
  const segments = value
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+$/, ""))
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) throw new Error(`Cannot derive a package path from ${value}`);
  return segments.join("/");
}

/**
 * Canonical string form, used when writing settings so the stored value is
 * stable regardless of how the human spelled it.
 */
export function formatSource(parsed: ParsedSource): string {
  if (parsed.type === "local") return parsed.path;
  const ref = parsed.ref ? `@${parsed.ref}` : "";
  const subpath = parsed.subpath ? `#${parsed.subpath}` : "";
  return `${parsed.url}${ref}${subpath}`;
}

// ── Materialization (git clone / local reference) ─────────────────────────────

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
 * hold conversation-scoped settings and package checkouts.
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
  const repoName = repoPath[repoPath.length - 1] ?? "repo";
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
  // A symlink inside the repository must not select files outside the clone:
  // the returned directory is mounted into the runtime, so follow
  // links before deciding the subpath stayed inside.
  const relation = relative(realpathSync(cloneDir), realpathSync(dir));
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error(`Subpath escapes repository: ${parsed.subpath}`);
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

// ── Inspection ────────────────────────────────────────────────────────────────

/**
 * The administrator's view of a conversation's packages: what each scope
 * declares, whether it is actually on disk, and what it contributes.
 *
 * Resolution answers "what loads"; inspection answers "why is this not
 * loading", which is the question someone staring at the portal has. A source
 * that failed to fetch, or one shadowed by the conversation's own copy, is
 * absent from the resolved set — reporting only the survivors would leave the
 * admin with a silently short list and nothing to act on.
 */

export type { PackageInventory } from "./types.js";

/**
 * Inventory both scopes for one conversation. Never throws and never fetches:
 * the portal renders this on page load, so it reports the current on-disk
 * truth rather than going to the network behind the admin's back.
 */
export async function inspectConversationPackages(
  options: ResolvePackagesOptions,
): Promise<PackageInventory> {
  const conversationIdentities = new Set(
    declaredSources("conversation", options).map(safeIdentityOrEmpty).filter(Boolean),
  );

  return {
    global: await Promise.all(
      declaredSources("global", options).map((source) =>
        describe(source, "global", options, conversationIdentities),
      ),
    ),
    conversation: await Promise.all(
      declaredSources("conversation", options).map((source) =>
        describe(source, "conversation", options, new Set()),
      ),
    ),
  };
}

/** Sources one scope declares, or an empty list when its settings are unreadable. */
function declaredSources(scope: PackageScope, options: ResolvePackagesOptions): string[] {
  try {
    const settings =
      scope === "global" ? loadGlobalSettings() : resolveConversationSettings(options.office);
    return settings.packages ?? [];
  } catch {
    return [];
  }
}

function safeIdentityOrEmpty(source: string): string {
  try {
    return sourceIdentity(parseSource(source));
  } catch {
    return "";
  }
}

async function describe(
  source: string,
  scope: PackageScope,
  options: ResolvePackagesOptions,
  shadowedBy: Set<string>,
): Promise<PackageStatus> {
  const base: PackageStatus = { source, scope, ready: false, skills: [] };

  let identity: string;
  try {
    identity = sourceIdentity(parseSource(source));
  } catch (err) {
    return { ...base, error: messageOf(err) };
  }

  let dir: string;
  try {
    dir = materializeSource(source, {
      scope,
      address: options.office.address,
      stateDir: options.office.workspace.stateDir,
      mode: "offline",
    }).dir;
  } catch (err) {
    return { ...base, error: messageOf(err) };
  }

  return {
    ...base,
    ready: true,
    dir,
    ...(shadowedBy.has(identity) ? { shadowed: true } : {}),
    skills: contributedSkills(dir),
  };
}

function contributedSkills(dir: string): string[] {
  const skillsDir = join(dir, "skills");
  return loadSkillsFromDir({ dir: skillsDir, source: "package" }).skills.map((skill) => skill.name);
}

// ── Resolution & skill mounts ─────────────────────────────────────────────────

/**
 * What a conversation actually loads: the two scopes' declared packages
 * combined, collisions resolved, and each surviving package turned into the
 * skill directories the runner consumes.
 *
 * Two rules do all the work here:
 *
 * - **Additive scopes.** `global` packages load for every conversation; a
 *   conversation's packages load on top. Neither list replaces the other.
 * - **Narrower scope wins.** When both scopes declare the same package
 *   ({@link sourceIdentity}, which ignores the ref), only the conversation's
 *   copy loads. That is what makes "pin this one channel to v2 while everyone
 *   else stays on v1" work, and it is why the same package installed twice
 *   cannot activate twice.
 *
 * Resolution never throws. A conversation with one malformed or unfetchable
 * source still loads every other package, and the failure is reported through
 * {@link ResolvedPackages.errors} for the portal and the logs. The alternative
 * — one bad string in settings taking a conversation offline — is a far worse
 * failure mode than a missing feature.
 */

export type { ResolvePackagesOptions, ResolvedPackages } from "./types.js";

/** Conventional resource directory inside a package, mirroring pi's layout. */
const SKILLS_SUBDIR = "skills";
/** Slug length cap; long identities keep a digest tail instead of colliding. */
const SLUG_MAX_LENGTH = 96;

/**
 * Where package resources appear inside the sandbox.
 *
 * Deliberately OUTSIDE `/workspace`. In `full` workspace-mount mode
 * `/workspace` is the entire working directory, so a `/workspace/packages`
 * mount would shadow a real `packages/` directory in the user's tree — mikan's
 * own repository has one. Living outside also keeps
 * `translateMountedRuntimePathToHost` correct by construction: it maps only
 * the `/workspace` prefix and returns everything else untouched, so a package
 * path can never be mistranslated into a host path that does not exist.
 *
 * Skills are referenced by absolute path in the system prompt, so the location
 * costs nothing in usability.
 */
const PACKAGE_RUNTIME_ROOT = "/mikan/packages";

/** Runtime path a package's skills directory is mounted at. */
export function packageSkillRuntimeDir(slug: string): string {
  return `${PACKAGE_RUNTIME_ROOT}/${slug}/${SKILLS_SUBDIR}`;
}

/**
 * Read-only mounts exposing every resolved package's skills to the sandbox.
 *
 * Read-only rather than read-write because the host owns these files: the
 * directory is a git checkout that an update replaces wholesale, so an agent
 * edit would be silently discarded on the next refresh. Making the filesystem
 * refuse the write turns a confusing data-loss bug into an obvious error.
 *
 * This pure step consumes an already resolved package set and never reaches the network.
 */
export function conversationPackageSkillMounts(
  packages: ResolvedPackages,
): Array<{ source: string; target: string; readOnly: true }> {
  return packages.skillDirs.map(({ slug, dir }) => ({
    source: dir,
    target: packageSkillRuntimeDir(slug),
    readOnly: true,
  }));
}

/**
 * Resolve the package set for one conversation. Reads both scopes' settings,
 * dedups, and reports the directories to load from.
 */
export function resolveConversationPackages(options: ResolvePackagesOptions): ResolvedPackages {
  const declarations = [...readScope("global", options), ...readScope("conversation", options)];

  const errors: PackageError[] = [];
  const byIdentity = new Map<string, MaterializedPackage>();

  for (const declaration of declarations) {
    let identity: string;
    try {
      identity = sourceIdentity(parseSource(declaration.source));
    } catch (err) {
      errors.push({ source: declaration.source, message: messageOf(err) });
      continue;
    }
    // Later scopes overwrite earlier ones: global is read first, so a
    // conversation declaring the same package shadows it.
    const existing = byIdentity.get(identity);
    if (existing && existing.scope !== declaration.scope) {
      log.logInfo(`Package ${identity} declared in both scopes; using the conversation's copy`);
    }
    const materialized = materialize(declaration, options, errors);
    if (materialized) byIdentity.set(identity, materialized);
    else byIdentity.delete(identity);
  }

  const packages = [...byIdentity.values()].toSorted(scopeOrder);
  return {
    packages,
    skillDirs: packages.flatMap(packageSkillDir),
    errors,
  };
}

interface Declaration {
  source: string;
  scope: PackageScope;
}

function readScope(scope: PackageScope, options: ResolvePackagesOptions): Declaration[] {
  try {
    const sources =
      scope === "global"
        ? loadGlobalSettings().packages
        : resolveConversationSettings(options.office).packages;
    return (sources ?? []).map((source) => ({ source, scope }));
  } catch (err) {
    // Unreadable settings must not take the conversation down; the other
    // scope, and the convention directories, still load.
    log.logWarning(`Could not read ${scope} package list`, messageOf(err));
    return [];
  }
}

function materialize(
  declaration: Declaration,
  options: ResolvePackagesOptions,
  errors: PackageError[],
): MaterializedPackage | undefined {
  try {
    return materializeSource(declaration.source, {
      scope: declaration.scope,
      address: options.office.address,
      stateDir: options.office.workspace.stateDir,
      mode: options.fetchMissing ? "fetch" : "offline",
    });
  } catch (err) {
    errors.push({ source: declaration.source, message: messageOf(err) });
    return undefined;
  }
}

function packageSkillDir(pkg: MaterializedPackage): PackageSkillDir[] {
  const dir = join(pkg.dir, SKILLS_SUBDIR);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return [{ slug: packageSlug(pkg), dir }];
}

/**
 * Filesystem-safe, collision-resistant name for a package, used as the mount
 * path segment for its skills. Derived from the identity rather than the
 * source string so the same package spelled two ways gets one name.
 */
function packageSlug(pkg: MaterializedPackage): string {
  const readable = pkg.identity
    .replace(/^(git|local):/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (readable.length <= SLUG_MAX_LENGTH) return readable;
  // Truncation alone would let two long identities sharing a prefix (deeply
  // nested self-hosted groups, file:// paths) land on the same slug — and
  // therefore the same mount target, where one package's skills would quietly
  // replace the other's. The digest makes the tail collision-resistant.
  const digest = createHash("sha256").update(pkg.identity).digest("hex").slice(0, 8);
  return `${readable.slice(0, SLUG_MAX_LENGTH - digest.length - 1)}-${digest}`;
}

/** Global packages load before conversation ones. */
function scopeRank(scope: PackageScope): number {
  return scope === "global" ? 0 : 1;
}

function scopeOrder(a: MaterializedPackage, b: MaterializedPackage): number {
  return scopeRank(a.scope) - scopeRank(b.scope);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Admin operations ──────────────────────────────────────────────────────────

/**
 * The write operations behind the admin portal's package panels.
 *
 * The ordering here is the whole point: **materialize first, persist second.**
 * A source is fetched and validated while the person who typed it is still
 * looking at the form, so a typo, a private repo, a bad `#subpath`, or a repo
 * with no skills in it fails in front of them. Persisting first and
 * fetching at load time would turn every one of those into "the bot just
 * doesn't have the skill", discovered later and usually by someone else.
 */

export type { PackageAdminContext, PackageWriteResult } from "./types.js";

/**
 * Add a source to a scope, or move an existing one to a new ref. Fetches and
 * validates before writing, and is idempotent: adding a source already present
 * re-materializes it and leaves the list unchanged.
 */
export function addPackage(
  scope: PackageScope,
  rawSource: string,
  context: PackageAdminContext,
): PackageWriteResult {
  const source = formatSource(parseSource(rawSource));
  const materialized = materializeSource(source, {
    scope,
    address: context.office.address,
    stateDir: context.office.workspace.stateDir,
    mode: "fetch",
  });

  const existing = declaredSources(scope, context);
  // Replace any entry for the same package so re-adding with a new ref moves
  // the pin instead of leaving two conflicting lines in settings.
  const identity = sameIdentityFilter(source);
  writePackages(scope, [...existing.filter((entry) => !identity(entry)), source], context);
  return { source, dir: materialized.dir };
}

/**
 * Drop a source from a scope's list. The materialized clone is left on disk —
 * removal is a declaration change, and keeping the checkout makes re-adding
 * instant and lets an admin undo a mistake without a network round trip.
 */
export function removePackage(
  scope: PackageScope,
  rawSource: string,
  context: PackageAdminContext,
): boolean {
  const existing = declaredSources(scope, context);
  const remaining = existing.filter((entry) => entry !== rawSource);
  if (remaining.length === existing.length) return false;
  writePackages(scope, remaining, context);
  return true;
}

/** Re-fetch a package that is already declared, moving it to its ref's current tip. */
export function refreshPackage(
  scope: PackageScope,
  rawSource: string,
  context: PackageAdminContext,
): PackageWriteResult {
  if (!declaredSources(scope, context).includes(rawSource)) {
    throw new Error(`Not declared in the ${scope} scope: ${rawSource}`);
  }
  const materialized = materializeSource(rawSource, {
    scope,
    address: context.office.address,
    stateDir: context.office.workspace.stateDir,
    mode: "refresh",
  });
  return { source: rawSource, dir: materialized.dir };
}

function sameIdentityFilter(source: string): (entry: string) => boolean {
  const target = safeIdentity(source);
  return (entry) => safeIdentity(entry) === target;
}

/**
 * Identity of a declared entry, falling back to the raw string when it does
 * not parse. A malformed entry must still be matchable so an admin can replace
 * or remove the exact line they typed.
 */
function safeIdentity(source: string): string {
  try {
    return sourceIdentity(parseSource(source));
  } catch {
    return `raw:${source}`;
  }
}

/**
 * Writes go through the settings-mutation seam rather than touching config
 * directly, so package edits obey the same runner-cache policy as every other
 * portal write. Packages are not a cached-runner key, so this writes and
 * leaves live conversations alone until their next harness instance.
 */
function writePackages(
  scope: PackageScope,
  packages: string[],
  context: PackageAdminContext,
): void {
  if (scope === "global") {
    applyGlobalSettings(context.runtime, { packages });
    return;
  }
  const result = applyConversationSettings(context.runtime, context.office, {
    packages,
  });
  if (!result.ok) throw new Error("Conversation is busy; try again when the current run ends");
}
