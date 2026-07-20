import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PlatformName } from "../adapter.js";
import { assertConversationId } from "./session-key.js";
import { readConversationStorageClaim } from "./conversation-storage.js";
import type { ConversationStorageCatalogEntry } from "./types.js";

const WORKSPACE_ROOT_DIRS = new Set(["skills", "events"]);

/**
 * Enumerate conversation storage without parsing hash-derived directory names.
 * Scoped mode trusts only durable claims; legacy mode preserves raw directory
 * behavior for existing Admin deployments.
 */
export function listConversationStorage(options: {
  workspaceRoot: string;
  scoped: boolean;
  legacyPlatform?: PlatformName;
}): ConversationStorageCatalogEntry[] {
  const entries: ConversationStorageCatalogEntry[] = [];
  const identities = new Set<string>();
  for (const dirent of readdirSync(options.workspaceRoot, { withFileTypes: true })) {
    if (dirent.name.startsWith(".") || WORKSPACE_ROOT_DIRS.has(dirent.name)) continue;
    const path = join(options.workspaceRoot, dirent.name);
    if (!dirent.isDirectory() || lstatSync(path).isSymbolicLink()) {
      if (options.scoped) {
        throw new Error(`Scoped conversation storage entry must be a real directory: ${path}`);
      }
      continue;
    }

    const entry = options.scoped
      ? { ...readConversationStorageClaim(path), conversationDir: path }
      : legacyEntry(path, dirent.name, options.legacyPlatform ?? "slack");
    const identity = `${entry.platform}\0${entry.conversationId}`;
    if (identities.has(identity)) {
      throw new Error(
        `Duplicate conversation storage identity ${entry.platform}/${entry.conversationId}`,
      );
    }
    identities.add(identity);
    entries.push(entry);
  }
  return entries.toSorted(
    (left, right) =>
      left.platform.localeCompare(right.platform) ||
      left.conversationId.localeCompare(right.conversationId),
  );
}

export function findConversationStorage(
  entries: readonly ConversationStorageCatalogEntry[],
  platform: PlatformName,
  conversationId: string,
): ConversationStorageCatalogEntry | undefined {
  assertConversationId(conversationId);
  return entries.find(
    (entry) => entry.platform === platform && entry.conversationId === conversationId,
  );
}

function legacyEntry(
  conversationDir: string,
  conversationId: string,
  platform: PlatformName,
): ConversationStorageCatalogEntry {
  assertConversationId(conversationId);
  return { platform, conversationId, storageKey: conversationId, conversationDir };
}
