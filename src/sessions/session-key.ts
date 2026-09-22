import type { ConversationKind, OfficeAddress } from "../types.js";
export type { ResolveSessionKeyOptions } from "./types.js";
import type { ResolveSessionKeyOptions } from "./types.js";

const PATH_SEPARATOR_PATTERN = /[\\/]/;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function assertSafeIdentityPart(value: string, label: string): string {
  if (!value || value === "." || value === "..") {
    throw new Error(`${label} must be a non-empty identity segment (got ${JSON.stringify(value)})`);
  }
  if (PATH_SEPARATOR_PATTERN.test(value)) {
    throw new Error(`${label} must not contain path separators (got ${JSON.stringify(value)})`);
  }
  if (containsControlCharacter(value)) {
    throw new Error(`${label} must not contain control characters (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function assertSessionConversationId(conversationId: string): string {
  assertSafeIdentityPart(conversationId, "Conversation id");
  if (conversationId.includes(":")) {
    throw new Error(
      `Conversation id must not contain ":" (got ${JSON.stringify(conversationId)}); ` +
        "the session-key grammar reserves it for thread suffixes",
    );
  }
  return conversationId;
}

export function assertSessionSuffix(suffix: string): string {
  return assertSafeIdentityPart(suffix, "Session suffix");
}

export function makeThreadSessionKey(conversationId: string, suffix: string): string {
  return `${assertSessionConversationId(conversationId)}:${assertSessionSuffix(suffix)}`;
}

export function assertSessionKeyBelongsToConversation(
  sessionKey: string,
  conversationId: string,
): string {
  const expectedConversationId = assertSessionConversationId(conversationId);
  const actualConversationId = conversationIdOf(sessionKey);
  if (actualConversationId !== expectedConversationId) {
    throw new Error(
      `Session key ${JSON.stringify(sessionKey)} does not belong to conversation ` +
        JSON.stringify(conversationId),
    );
  }
  const suffix = threadSuffixOf(sessionKey);
  if (suffix !== null) assertSessionSuffix(suffix);
  return sessionKey;
}

export function deriveSessionKey(event: {
  address: OfficeAddress;
  sessionKey?: string;
  thread_ts?: string;
  ts: string;
}): string {
  const conversationId = event.address.conversationId;
  if (event.sessionKey !== undefined) {
    return assertSessionKeyBelongsToConversation(event.sessionKey, conversationId);
  }
  return makeThreadSessionKey(conversationId, event.thread_ts ?? event.ts);
}

export function isThreadSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":");
}

export function conversationIdOf(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator === -1 ? sessionKey : sessionKey.slice(0, separator);
}

export function threadSuffixOf(sessionKey: string): string | null {
  const separator = sessionKey.indexOf(":");
  return separator === -1 ? null : sessionKey.slice(separator + 1);
}

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
    return assertSessionConversationId(conversationId);
  }
  if (!threadTs && persistentTopLevel) {
    return assertSessionConversationId(conversationId);
  }
  return makeThreadSessionKey(conversationId, threadTs || messageId);
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
