import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { platform as hostPlatform } from "node:os";
import { join } from "node:path";
import type { PlatformName } from "../adapter.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";
import { isRecord, readJsonFileIfExists } from "../utils/file-guards.js";
import { resolveConversationStorage } from "./conversation-storage.js";
import type {
  ConversationStorageCompletionRecord,
  ConversationStorageManagerOptions,
  ConversationStorageMigrationResult,
  ConversationStorageOwnershipManifest,
} from "./types.js";
import { assertConversationId } from "./session-key.js";

const PLATFORM_NAMES = new Set<PlatformName>(["slack", "discord", "telegram", "github"]);

export function readConversationStorageOwnershipManifest(
  path: string,
): ConversationStorageOwnershipManifest {
  const manifest = readJsonFileIfExists(
    path,
    isOwnershipManifest,
    (detail) => `Invalid conversation storage ownership manifest ${path}: ${detail}`,
  );
  if (!manifest) throw new Error(`Conversation storage ownership manifest does not exist: ${path}`);
  for (const conversationId of Object.keys(manifest.owners)) assertConversationId(conversationId);
  return manifest;
}

/** Apply only operator-declared ownership; omitted legacy state remains untouched. */
export async function migrateConversationStorage(
  manifest: ConversationStorageOwnershipManifest,
  options: ConversationStorageManagerOptions,
): Promise<ConversationStorageMigrationResult[]> {
  const active = new Set(options.activePlatforms);
  const results: ConversationStorageMigrationResult[] = [];
  for (const [conversationId, platform] of Object.entries(manifest.owners).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!active.has(platform)) {
      throw new Error(
        `Conversation storage owner ${platform}/${conversationId} is not an active platform`,
      );
    }
    const resolved = await resolveConversationStorage({
      workspaceRoot: options.workspaceRoot,
      platform,
      conversationId,
      // The manifest is explicit ownership proof for this item. Ordinary
      // first-use resolution retains all active platforms and still rejects
      // ambiguous legacy state.
      activePlatforms: [platform],
      ...(options.fenceLegacyAuthority
        ? {
            fenceLegacyAuthority: () => options.fenceLegacyAuthority!(platform, conversationId),
          }
        : {}),
    });
    results.push({
      conversationId,
      platform,
      storageKey: resolved.storageKey,
      conversationDir: resolved.conversationDir,
      migratedLegacy: resolved.migratedLegacy,
    });
  }
  return results;
}

export function migrateConversationSettingsState(
  stateDir: string,
  conversationId: string,
  storageKey: string,
): boolean {
  assertConversationId(conversationId);
  assertConversationId(storageKey);
  const root = join(stateDir, "conversations");
  const source = join(root, conversationId);
  const target = join(root, storageKey);
  const sourceExists = assertRealDirectoryOrMissing(source, "legacy conversation settings");
  const targetExists = assertRealDirectoryOrMissing(target, "scoped conversation settings");
  if (sourceExists && targetExists) {
    throw new Error(
      `Conversation settings migration conflict: both ${conversationId} and ${storageKey} exist`,
    );
  }
  if (!sourceExists) return false;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  renameSync(source, target);
  syncDirectory(root);
  return true;
}

function assertRealDirectoryOrMissing(path: string, label: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} must be a real directory: ${path}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(path: string): void {
  if (hostPlatform() === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function invalidateConversationStorageCompletion(stateDir: string): void {
  const path = join(stateDir, "conversation-storage-v1.ready.json");
  rmSync(path, { force: true });
  syncDirectory(stateDir);
}

export function readConversationStorageCompletion(options: {
  stateDir: string;
  workspaceRoot: string;
}): ConversationStorageCompletionRecord | undefined {
  const path = join(options.stateDir, "conversation-storage-v1.ready.json");
  const record = readJsonFileIfExists(
    path,
    isCompletionRecord,
    (detail) => `Invalid conversation storage completion record ${path}: ${detail}`,
  );
  if (!record) return undefined;
  const expectedRoot = realpathSync(options.workspaceRoot);
  if (record.workspaceRoot !== expectedRoot) {
    throw new Error(
      `Conversation storage completion record belongs to ${record.workspaceRoot}, not ${expectedRoot}`,
    );
  }
  return record;
}

export function writeConversationStorageCompletion(options: {
  stateDir: string;
  workspaceRoot: string;
  manifest: ConversationStorageOwnershipManifest;
  now?: () => Date;
}): ConversationStorageCompletionRecord {
  if (!options.manifest.complete) {
    throw new Error("Conversation storage ownership manifest must declare complete: true");
  }
  const record: ConversationStorageCompletionRecord = {
    version: 1,
    workspaceRoot: realpathSync(options.workspaceRoot),
    manifestDigest: createHash("sha256")
      .update(JSON.stringify(canonicalManifest(options.manifest)))
      .digest("hex"),
    completedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  atomicWritePrivateFile(
    join(options.stateDir, "conversation-storage-v1.ready.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  return record;
}

function canonicalManifest(
  manifest: ConversationStorageOwnershipManifest,
): ConversationStorageOwnershipManifest {
  return {
    version: 1,
    complete: manifest.complete,
    owners: Object.fromEntries(
      Object.entries(manifest.owners).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function isCompletionRecord(value: unknown): value is ConversationStorageCompletionRecord {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  return (
    value.version === 1 &&
    typeof value.workspaceRoot === "string" &&
    value.workspaceRoot.length > 0 &&
    typeof value.manifestDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.manifestDigest) &&
    typeof value.completedAt === "string" &&
    !Number.isNaN(Date.parse(value.completedAt))
  );
}

function isOwnershipManifest(value: unknown): value is ConversationStorageOwnershipManifest {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.version !== 1) return false;
  if (typeof value.complete !== "boolean" || !isRecord(value.owners)) return false;
  return Object.values(value.owners).every(
    (platform): platform is PlatformName =>
      typeof platform === "string" && PLATFORM_NAMES.has(platform as PlatformName),
  );
}
