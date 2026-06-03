// ── event tool ───────────────────────────────────────────────────────────────

export type EventPayload =
  | {
      type: "immediate";
      platform: string;
      conversationId: string;
      conversationKind: "direct" | "shared";
      userId: string;
      text: string;
    }
  | {
      type: "one-shot";
      platform: string;
      conversationId: string;
      conversationKind: "direct" | "shared";
      userId: string;
      text: string;
      at: string;
    }
  | {
      type: "periodic";
      platform: string;
      conversationId: string;
      conversationKind: "direct" | "shared";
      userId: string;
      text: string;
      schedule: string;
      timezone: string;
    };

export interface EventStore {
  write(filename: string, payload: EventPayload): Promise<{ path: string; size: number }>;
}

// ── truncation ───────────────────────────────────────────────────────────────

export interface TruncationResult {
  /** The truncated content */
  content: string;
  /** Whether truncation occurred */
  truncated: boolean;
  /** Which limit was hit: "lines", "bytes", or null if not truncated */
  truncatedBy: "lines" | "bytes" | null;
  /** Total number of lines in the original content */
  totalLines: number;
  /** Total number of bytes in the original content */
  totalBytes: number;
  /** Number of complete lines in the truncated output */
  outputLines: number;
  /** Number of bytes in the truncated output */
  outputBytes: number;
  /** Whether the last line was partially truncated (only for tail truncation edge case) */
  lastLinePartial: boolean;
  /** Whether the first line exceeded the byte limit (for head truncation) */
  firstLineExceedsLimit: boolean;
}

export interface TruncationOptions {
  /** Maximum number of lines (default: 2000) */
  maxLines?: number;
  /** Maximum number of bytes (default: 50KB) */
  maxBytes?: number;
}
