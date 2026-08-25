import type { ConversationKind } from "../adapter.js";
export type { ResolveSessionKeyOptions } from "./types.js";
import type { ResolveSessionKeyOptions } from "./types.js";

/**
 * The session-key grammar. A session key is the conversation-scoped runtime
 * identity used to serialize and resume work (see CONTEXT.md):
 *
 *   `conversationId`            — the persistent conversation session
 *   `conversationId:suffix`     — a scoped thread session (suffix = thread
 *                                 ts / message id, opaque to this module)
 *
 * This module owns the convention; nothing else may split on ":". The grammar
 * only works because conversation ids never contain ":" — that invariant is
 * asserted here at every derivation instead of being assumed everywhere.
 */

/** Characters that can change host path structure or make identity logs ambiguous. */
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

export function assertConversationId(conversationId: string): string {
  assertSafeIdentityPart(conversationId, "Conversation id");
  if (conversationId.includes(":")) {
    throw new Error(
      `Conversation id must not contain ":" (got ${JSON.stringify(conversationId)}); ` +
        "the session-key grammar reserves it for thread suffixes",
    );
  }
  return conversationId;
}

/** Validate the opaque scoped suffix without changing its platform value. */
export function assertSessionSuffix(suffix: string): string {
  return assertSafeIdentityPart(suffix, "Session suffix");
}

/** Build a scoped thread session key. */
export function makeThreadSessionKey(conversationId: string, suffix: string): string {
  return `${assertConversationId(conversationId)}:${assertSessionSuffix(suffix)}`;
}

/**
 * Validate that a platform-computed session key belongs to its conversation.
 * The key may be the bare conversation id or one of that conversation's
 * scoped keys; callers must not be able to select another conversation's
 * runtime/cache entry.
 */
export function assertSessionKeyBelongsToConversation(
  sessionKey: string,
  conversationId: string,
): string {
  const expectedConversationId = assertConversationId(conversationId);
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

/**
 * The runtime fallback: honor a platform-computed session key, otherwise
 * scope the event to its thread (or to itself for thread-starting messages).
 */
export function deriveSessionKey(event: {
  sessionKey?: string;
  conversationId: string;
  thread_ts?: string;
  ts: string;
}): string {
  if (event.sessionKey !== undefined) {
    return assertSessionKeyBelongsToConversation(event.sessionKey, event.conversationId);
  }
  return makeThreadSessionKey(event.conversationId, event.thread_ts ?? event.ts);
}

export function isThreadSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(":");
}

/** The conversation a session key belongs to (identity for bare keys). */
export function conversationIdOf(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator === -1 ? sessionKey : sessionKey.slice(0, separator);
}

/** The thread suffix of a scoped key, or null for a bare conversation key. */
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
    return assertConversationId(conversationId);
  }
  if (!threadTs && persistentTopLevel) {
    return assertConversationId(conversationId);
  }
  return makeThreadSessionKey(conversationId, threadTs || messageId);
}

export function inferConversationKind(platform: string, conversationId: string): ConversationKind {
  if (platform === "web") return "direct";

  if (platform === "slack") {
    return conversationId.startsWith("D") ? "direct" : "shared";
  }

  if (platform === "telegram") {
    return conversationId.startsWith("-") ? "shared" : "direct";
  }

  if (platform === "discord") {
    return conversationId.startsWith("DM") ? "direct" : "shared";
  }

  // github: issues/PRs are always shared within the repo; there are no DMs.
  return "shared";
}
