/**
 * The write operations behind the admin portal's package panels.
 *
 * The ordering here is the whole point: **materialize first, persist second.**
 * A source is fetched and validated while the person who typed it is still
 * looking at the form, so a typo, a private repo, a bad `#subpath`, or a repo
 * with no extension in it fails in front of them. Persisting first and
 * fetching at load time would turn every one of those into "the bot just
 * doesn't have the feature", discovered later and usually by someone else.
 *
 * Activation stays where it was: the next harness instance (`/pi-new`) picks
 * up what is on disk. Only the failure reporting moves earlier.
 */
import { applyConversationSettings, applyGlobalSettings } from "../settings-mutation.js";
import type { GlobalRunnerCacheControl, RunnerCacheControl } from "../settings-mutation.js";
import { formatSource, parseSource, sourceIdentity } from "./source.js";
import { materializeSource } from "./materialize.js";
import { declaredSources } from "./inspect.js";
import type { PackageScope } from "./types.js";
import type { ResolvePackagesOptions } from "./resolve.js";

export interface PackageAdminContext extends ResolvePackagesOptions {
  /** Working directory holding conversation dirs; needed to write settings. */
  workingDir: string;
  runtime?: RunnerCacheControl & GlobalRunnerCacheControl;
}

export interface PackageWriteResult {
  /** The canonical source string as persisted. */
  source: string;
  /** Host directory the package materialized into. */
  dir: string;
}

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
    conversationId: context.conversationId,
    stateDir: context.stateDir,
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
    conversationId: context.conversationId,
    stateDir: context.stateDir,
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
  const result = applyConversationSettings(
    context.runtime,
    context.workingDir,
    context.conversationId,
    { packages },
  );
  if (!result.ok) throw new Error("Conversation is busy; try again when the current run ends");
}
