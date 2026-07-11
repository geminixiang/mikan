/**
 * Core types for the mikan agent harness.
 *
 * The harness is built directly on pi-agent-core and pi-ai. Session entries
 * are structurally identical to pi-agent-core's `SessionTreeEntry`, and the
 * on-disk JSONL format stays compatible with the v3 session files mikan has
 * always written, so existing conversation history keeps working unchanged.
 */
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  MessageEntry,
  SessionContext,
  SessionInfoEntry,
  SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  SessionContext,
  SessionInfoEntry,
};

/** Message entry as stored in mikan session files. */
export type SessionMessageEntry = MessageEntry;

/** Union of entry types mikan reads and writes. Alias of pi-agent-core's tree entry. */
export type SessionEntry = SessionTreeEntry;

export const CURRENT_SESSION_VERSION = 3;

/**
 * First line of every session file. `cwd` records where the session was
 * started; extra fields (for example mikan's `source` marker) are preserved
 * verbatim on read and rewrite.
 */
export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  [extra: string]: unknown;
}

/** Raw file line: the header or one session entry. */
export type SessionFileEntry = SessionHeader | SessionEntry;
