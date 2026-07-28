/**
 * A package source as written by a human: the string stored in `packages[]`
 * in global or conversation settings, and the string typed into the admin
 * portal. Parsing it is {@link parseSource}'s job.
 */
export type PackageSourceString = string;

/** Scope a package belongs to. `global` spans every conversation. */
export type PackageScope = "global" | "conversation";

/**
 * A git source. `ref` is a tag, branch, or commit — absent means "whatever the
 * remote's default branch points at now", which only moves on an explicit
 * update. `subpath` addresses a package inside a larger repository.
 */
interface GitSource {
  type: "git";
  /** Clone URL handed to `git`, after shorthand expansion. */
  url: string;
  ref?: string;
  subpath?: string;
}

/**
 * A directory on the mikan host, used by reference — never copied. Editing the
 * directory is picked up by the next harness instance, which is what makes
 * host-side development of an extension bearable.
 */
interface LocalSource {
  type: "local";
  path: string;
}

export type ParsedSource = GitSource | LocalSource;

/**
 * Stable identity of a package, independent of version and of the scope it is
 * installed in. Two sources with the same identity are the same package, so
 * the conversation scope's copy can shadow the global one.
 *
 * Deliberately excludes the ref: `…/repo@v1` in global and `…/repo@v2` in a
 * conversation are one package pinned two ways, and the conversation wins.
 */
export type PackageIdentity = string;

/** Where a materialized package's files live, plus how it got there. */
export interface MaterializedPackage {
  source: PackageSourceString;
  parsed: ParsedSource;
  identity: PackageIdentity;
  /**
   * Directory holding the package's files. For git this is inside the state
   * dir (a clone, plus `subpath`); for local it is the referenced path itself.
   */
  dir: string;
  scope: PackageScope;
}

/** A source that failed to materialize, reported back to whoever asked. */
export interface PackageError {
  source: PackageSourceString;
  message: string;
}

export interface ResolvedPackages {
  packages: MaterializedPackage[];
  extensionDirs: string[];
  extensionRoots: string[];
  skillDirs: PackageSkillDir[];
  errors: PackageError[];
}

export interface PackageSkillDir {
  slug: string;
  dir: string;
}

export interface ResolvePackagesOptions {
  /** Office whose packages resolve; state-dir keys derive from it. */
  address: import("../types.js").OfficeAddress;
  stateDir: string;
  conversationDir: string;
  fetchMissing?: boolean;
}

export type MaterializeMode = "offline" | "fetch" | "refresh";

export interface MaterializeOptions {
  scope: PackageScope;
  address?: import("../types.js").OfficeAddress;
  stateDir: string;
  mode?: MaterializeMode;
}

export interface PackageStatus {
  source: string;
  scope: PackageScope;
  ready: boolean;
  error?: string;
  dir?: string;
  shadowed?: boolean;
  extensions: string[];
  skills: string[];
}

export interface PackageInventory {
  global: PackageStatus[];
  conversation: PackageStatus[];
}

export interface PackageAdminContext extends ResolvePackagesOptions {
  workingDir: string;
  runtime?: import("../types.js").RunnerCacheControl &
    import("../types.js").GlobalRunnerCacheControl;
}

export interface PackageWriteResult {
  source: string;
  dir: string;
}
