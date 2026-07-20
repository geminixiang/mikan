import type { PlatformName } from "../adapter.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { gondolinFleet } from "../sandbox/gondolin-fleet.js";
import { credentialAuthorizationKey, runtimeResourceKey } from "../sandbox/identity.js";
import {
  invalidateConversationStorageCompletion,
  migrateConversationSettingsState,
  migrateConversationStorage,
  readConversationStorageOwnershipManifest,
  writeConversationStorageCompletion,
} from "../sessions/conversation-storage-migration.js";
import type { ConversationStorageMigrationResult } from "../sessions/types.js";
import { FileVaultManager } from "../vault/index.js";

export async function runConversationStorageMigration(options: {
  manifestPath: string;
  workspaceRoot: string;
  stateDir: string;
  sandbox: SandboxConfig;
}): Promise<ConversationStorageMigrationResult[]> {
  const manifest = readConversationStorageOwnershipManifest(options.manifestPath);
  invalidateConversationStorageCompletion(options.stateDir);
  const activePlatforms = Array.from(new Set(Object.values(manifest.owners))) as PlatformName[];
  const results = await migrateConversationStorage(manifest, {
    workspaceRoot: options.workspaceRoot,
    activePlatforms,
    ...(options.sandbox.type === "gondolin" && options.sandbox.profile === "remote"
      ? {
          fenceLegacyAuthority: async (_platform: PlatformName, conversationId: string) => {
            const legacyResourceKey = runtimeResourceKey(options.sandbox, {
              userId: "",
              conversationId,
            });
            await gondolinFleet.fenceInstance(legacyResourceKey);
          },
        }
      : {}),
  });
  const vault = new FileVaultManager(options.stateDir);
  for (const result of results) {
    const legacyKey = credentialAuthorizationKey(options.sandbox, {
      userId: "",
      conversationId: result.conversationId,
    });
    const scopedKey = credentialAuthorizationKey(options.sandbox, {
      userId: "",
      conversationId: result.storageKey,
    });
    if (legacyKey !== scopedKey) vault.migrateKey(legacyKey, scopedKey);
    migrateConversationSettingsState(options.stateDir, result.conversationId, result.storageKey);
  }
  writeConversationStorageCompletion({
    stateDir: options.stateDir,
    workspaceRoot: options.workspaceRoot,
    manifest,
  });
  return results;
}
