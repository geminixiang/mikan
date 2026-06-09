import type { ConversationKind } from "../adapter.js";
export type { ResolveSessionKeyOptions } from "./types.js";
import type { ResolveSessionKeyOptions } from "./types.js";

export function resolveChatSessionKey(options: ResolveSessionKeyOptions): string {
  const {
    conversationId,
    conversationKind,
    messageId,
    persistentTopLevel,
    scopeDirectThreads,
    threadTs,
  } = options;
  if (conversationKind === "direct" && (!threadTs || !scopeDirectThreads)) {
    return conversationId;
  }
  if (!threadTs && persistentTopLevel) {
    return conversationId;
  }
  return `${conversationId}:${threadTs || messageId}`;
}

export function inferConversationKind(platform: string, conversationId: string): ConversationKind {
  if (platform === "slack") {
    return conversationId.startsWith("D") ? "direct" : "shared";
  }

  if (platform === "telegram") {
    return conversationId.startsWith("-") ? "shared" : "direct";
  }

  if (platform === "discord") {
    return conversationId.startsWith("DM") ? "direct" : "shared";
  }

  return "shared";
}
