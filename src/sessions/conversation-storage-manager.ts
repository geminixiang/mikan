import type { PlatformName } from "../adapter.js";
import type { ConversationStorageManagerOptions, ResolvedConversationStorage } from "./types.js";
import { resolveConversationStorage } from "./conversation-storage.js";
import { conversationStorageScope } from "./conversation-storage-scope.js";

/**
 * One process-wide seam for conversation storage resolution. Concurrent path
 * users share the same migration transaction; failed resolutions are removed
 * from the cache so an operator repair or recovered worker can be retried.
 */
export class ConversationStorageManager {
  private readonly resolutions = new Map<string, Promise<ResolvedConversationStorage>>();
  private readonly resolvedValues = new Map<string, ResolvedConversationStorage>();

  constructor(private readonly options: ConversationStorageManagerOptions) {}

  storageKey(platform: PlatformName, conversationId: string): string {
    return conversationStorageScope(platform, conversationId).storageKey;
  }

  resolved(
    platform: PlatformName,
    conversationId: string,
  ): ResolvedConversationStorage | undefined {
    const key = conversationStorageScope(platform, conversationId).storageKey;
    return this.resolvedValues.get(key);
  }

  requireResolved(platform: PlatformName, conversationId: string): ResolvedConversationStorage {
    const resolved = this.resolved(platform, conversationId);
    if (!resolved) {
      throw new Error(`Conversation storage is not resolved for ${platform}/${conversationId}`);
    }
    return resolved;
  }

  resolve(platform: PlatformName, conversationId: string): Promise<ResolvedConversationStorage> {
    const scope = conversationStorageScope(platform, conversationId);
    const existing = this.resolutions.get(scope.storageKey);
    if (existing) return existing;

    const resolving = resolveConversationStorage({
      workspaceRoot: this.options.workspaceRoot,
      platform,
      conversationId,
      activePlatforms: this.options.activePlatforms,
      ...(this.options.fenceLegacyAuthority
        ? {
            fenceLegacyAuthority: () =>
              this.options.fenceLegacyAuthority!(platform, conversationId),
          }
        : {}),
    });
    this.resolutions.set(scope.storageKey, resolving);
    void resolving.then(
      (resolved) => {
        if (this.resolutions.get(scope.storageKey) === resolving) {
          this.resolvedValues.set(scope.storageKey, resolved);
        }
      },
      () => {
        if (this.resolutions.get(scope.storageKey) === resolving) {
          this.resolutions.delete(scope.storageKey);
          this.resolvedValues.delete(scope.storageKey);
        }
      },
    );
    return resolving;
  }
}
