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

export function assertConversationId(conversationId: string): string {
  if (conversationId.includes(":")) {
    throw new Error(
      `Conversation id must not contain ":" (got ${JSON.stringify(conversationId)}); ` +
        "the session-key grammar reserves it for thread suffixes",
    );
  }
  return conversationId;
}

/** Build a scoped thread session key. */
export function makeThreadSessionKey(conversationId: string, suffix: string): string {
  return `${assertConversationId(conversationId)}:${suffix}`;
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
  return (
    event.sessionKey ?? makeThreadSessionKey(event.conversationId, event.thread_ts ?? event.ts)
  );
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
