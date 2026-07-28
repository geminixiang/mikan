/**
 * What a conversation actually loads: the two scopes' declared packages
 * combined, collisions resolved, and each surviving package turned into the
 * directories the extension loader and the skill loader consume.
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
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadGlobalSettings, resolveConversationSettings } from "../config.js";
import * as log from "../log.js";
import { materializeSource, packageScopeDir } from "./materialize.js";
import { parseSource, sourceIdentity } from "./source.js";
import type {
  MaterializedPackage,
  PackageError,
  PackageScope,
  PackageSkillDir,
  ResolvePackagesOptions,
  ResolvedPackages,
} from "./types.js";

export type { ResolvePackagesOptions, ResolvedPackages } from "./types.js";

/** Conventional resource directories inside a package, mirroring pi's layout. */
const EXTENSIONS_SUBDIR = "extensions";
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
 * Resolution is offline, so building the mount list never reaches the network.
 */
export function conversationPackageSkillMounts(
  options: ResolvePackagesOptions,
): Array<{ source: string; target: string; readOnly: true }> {
  return resolveConversationPackages(options).skillDirs.map(({ slug, dir }) => ({
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
  const targets = packages.map(packageExtensionTargets);
  return {
    packages,
    extensionDirs: [...scopeConventionDirs(options), ...targets.flatMap((target) => target.dirs)],
    extensionRoots: targets.flatMap((target) => target.roots),
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
        : resolveConversationSettings({
            address: options.address,
            conversationDir: options.conversationDir,
          }).packages;
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
      address: options.address,
      stateDir: options.stateDir,
      mode: options.fetchMissing ? "fetch" : "offline",
    });
  } catch (err) {
    errors.push({ source: declaration.source, message: messageOf(err) });
    return undefined;
  }
}

/**
 * The convention directories that need no declaration:
 * `<stateDir>/global/extensions` and
 * `<stateDir>/conversations/<id>/extensions`. These are the directories
 * `mikan ext install` writes into, so CLI installs and portal-declared
 * packages coexist.
 */
function scopeConventionDirs(options: ResolvePackagesOptions): string[] {
  return [
    join(packageScopeDir("global", undefined, options.stateDir), EXTENSIONS_SUBDIR),
    join(packageScopeDir("conversation", options.address, options.stateDir), EXTENSIONS_SUBDIR),
  ];
}

/**
 * How a package contributes extensions. Two shapes are accepted, and which one
 * applies is decided by the package's own layout rather than by configuration:
 *
 * - **Collection**: an `extensions/` subdirectory, scanned for named children.
 *   This is the shape a repository shipping several extensions has.
 * - **Single extension**: no `extensions/` subdirectory, but the package root
 *   is itself a loadable extension (an index file, or a `package.json` with
 *   `mikan.extensions`). This is what a one-extension repo looks like, and it
 *   is what a developer's working copy looks like — so `mikan ext dev` needs
 *   no special case.
 *
 * The slug comes from the package directory name in the single-extension
 * shape, so a repo named for its extension gets the identity its author
 * expects.
 */
function packageExtensionTargets(pkg: MaterializedPackage): { dirs: string[]; roots: string[] } {
  const collection = join(pkg.dir, EXTENSIONS_SUBDIR);
  if (existsSync(collection)) return { dirs: [collection], roots: [] };
  return { dirs: [], roots: [pkg.dir] };
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
