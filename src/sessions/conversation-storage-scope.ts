import { createHash } from "node:crypto";
import type { PlatformName } from "../adapter.js";
import type { ConversationStorageScope } from "./types.js";
import { assertConversationId } from "./session-key.js";

const STORAGE_SCOPE_HASH_LENGTH = 16;
const PLATFORM_NAMES = new Set<PlatformName>(["slack", "discord", "telegram", "github"]);

/**
 * Derive the one identity used by every conversation-owned storage/runtime
 * resource. The wire conversation id remains unchanged at platform seams.
 *
 * The key stays flat under the workspace root because existing memory, skill,
 * event, and projection code treats dirname(conversationDir) as that root.
 */
export function conversationStorageScope(
  platform: PlatformName,
  conversationId: string,
): ConversationStorageScope {
  if (!PLATFORM_NAMES.has(platform)) {
    throw new Error(`Unsupported conversation storage platform ${JSON.stringify(platform)}`);
  }
  const wireId = assertConversationId(conversationId);
  const readable = sanitizeStorageSegment(wireId).slice(0, 40).replace(/-+$/g, "") || "unknown";
  const hash = createHash("sha256")
    .update(`conversation-storage-v1\0${platform}\0${wireId}`)
    .digest("hex")
    .slice(0, STORAGE_SCOPE_HASH_LENGTH);
  return {
    platform,
    conversationId: wireId,
    storageKey: `${platform}-${readable}-${hash}`,
  };
}

function sanitizeStorageSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
