/**
 * @geminixiang/mikan-daemon-web-bridge — types and seams shared between the
 * mikan daemon (src/) and the web surface (packages/web-client, packages/ui-*).
 * Type-only, JSON-serializable shapes: the wire contract the React SPA fetches
 * and the daemon serves. The daemon re-exports these from its own types.ts so
 * existing import sites stay unchanged.
 */

// ── session view ─────────────────────────────────────────────────────────────

/** One rendered entry in a session timeline. */
export interface SessionViewItem {
  kind: "user" | "assistant" | "tool" | "system";
  title: string;
  body?: string;
  meta?: string;
  tone?: "default" | "ok" | "err" | "muted";
  entryId?: string;
  threads?: SessionViewRelation[];
}

/** A parent or thread session linked to the displayed one. */
export interface SessionViewRelation {
  kind: "parent" | "thread";
  fileName: string;
  sessionId: string;
  title: string;
  updatedAt: string;
  entryCount: number;
  summary?: string;
  anchorEntryId?: string;
}

/** The full session-view model served by GET /api/session/view. */
export interface SessionViewModel {
  sessionId: string;
  fileName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  items: SessionViewItem[];
  parent?: SessionViewRelation;
  threads: SessionViewRelation[];
}

/** Response body of GET /api/session/view?token=…&session=…. */
export interface SessionViewApiResponse {
  model: SessionViewModel;
  isRunning: boolean;
  displayedSessionKey: string;
  conversationId: string;
  expiresAt: number;
}
