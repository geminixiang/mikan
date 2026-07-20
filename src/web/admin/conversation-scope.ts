import type { PlatformName } from "../../adapter.js";
import { assertConversationId } from "../../sessions/session-key.js";
import type { AdminConversationScope } from "./types.js";

export function adminConversationScopeKey(platform: PlatformName, conversationId: string): string {
  return `${platform}:${assertConversationId(conversationId)}`;
}

export function parseAdminConversationScopeKey(value: string): {
  platform: PlatformName;
  conversationId: string;
} {
  const separator = value.indexOf(":");
  if (separator <= 0) throw new Error("Invalid admin conversation scope");
  const platform = value.slice(0, separator);
  if (!["slack", "discord", "telegram", "github"].includes(platform)) {
    throw new Error("Invalid admin conversation platform");
  }
  return {
    platform: platform as PlatformName,
    conversationId: assertConversationId(value.slice(separator + 1)),
  };
}

export function withAdminScopeKey(
  scope: Omit<AdminConversationScope, "scopeKey">,
): AdminConversationScope {
  return {
    ...scope,
    scopeKey: adminConversationScopeKey(scope.platform, scope.conversationId),
  };
}
