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
import { isAbsolute, resolve } from "node:path";
import type { PackageIdentity, ParsedSource } from "./types.js";

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
    return git(`https://github.com/${repo}.git`, ref, subpath);
  }

  if (locator.startsWith("git:")) {
    const inner = locator.slice("git:".length);
    if (isProtocolUrl(inner) || SCP_LIKE.test(inner)) return git(inner, ref, subpath);
    // Shorthand: host/owner/repo — only meaningful with the git: prefix,
    // since bare host/owner/repo is ambiguous with a relative path.
    if (!inner.includes("/")) {
      throw new Error(`git: source must include a path, got ${JSON.stringify(locator)}`);
    }
    return git(`https://${stripGitSuffix(inner)}.git`, ref, subpath);
  }

  if (isProtocolUrl(locator) || SCP_LIKE.test(locator)) return git(locator, ref, subpath);

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

function git(url: string, ref: string | undefined, subpath: string | undefined): ParsedSource {
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
 * - The subpath is included: two extensions living at different paths in one
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
  const host = scpMatch[2].toLowerCase();
  const path = stripGitSuffix(scpMatch[3].replace(/^\/+/, ""));
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
