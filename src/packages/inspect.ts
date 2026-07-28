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
import { join } from "node:path";
import { listInstalledExtensions, loadSkillsFromDir, validateExtension } from "../harness/index.js";
import { loadGlobalSettings, resolveConversationSettings } from "../config.js";
import { parseSource, sourceIdentity } from "./source.js";
import { materializeSource } from "./materialize.js";
import type {
  PackageInventory,
  PackageScope,
  PackageStatus,
  ResolvePackagesOptions,
} from "./types.js";

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
    declaredSources("conversation", options).map(safeIdentity).filter(Boolean),
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
export function declaredSources(scope: PackageScope, options: ResolvePackagesOptions): string[] {
  try {
    const settings =
      scope === "global"
        ? loadGlobalSettings()
        : resolveConversationSettings({
            conversationId: options.conversationId,
            conversationDir: options.conversationDir,
          });
    return settings.packages ?? [];
  } catch {
    return [];
  }
}

function safeIdentity(source: string): string {
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
  const base: PackageStatus = { source, scope, ready: false, extensions: [], skills: [] };

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
      conversationId: options.conversationId,
      stateDir: options.stateDir,
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
    extensions: await contributedExtensions(dir),
    skills: contributedSkills(dir),
  };
}

/**
 * Mirrors the loader's two accepted layouts (an `extensions/` collection, or a
 * package that is itself one extension) so the portal reports exactly what
 * would activate — including the slug, which is the name the extension's data
 * dir, secrets, and schedules are keyed by.
 */
async function contributedExtensions(dir: string): Promise<string[]> {
  const collection = listInstalledExtensions([join(dir, "extensions")]);
  if (collection.length > 0) return collection.map((info) => info.slug);
  // Single-extension layout: validate the root itself rather than scanning its
  // parent, which would report unrelated siblings.
  const validated = await validateExtension(dir);
  return validated.ok ? [validated.slug] : [];
}

function contributedSkills(dir: string): string[] {
  const skillsDir = join(dir, "skills");
  return loadSkillsFromDir({ dir: skillsDir, source: "package" }).skills.map((skill) => skill.name);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
