import type { MikanEvent } from "../types.js";

// ── event tool ───────────────────────────────────────────────────────────────

export type EventPayload = MikanEvent;

export interface EventStore {
  write(filename: string, payload: MikanEvent): Promise<{ path: string; size: number }>;
  list(): Promise<Array<{ filename: string; payload: MikanEvent; size: number; mtimeMs: number }>>;
  read(
    filename: string,
  ): Promise<{ filename: string; payload: MikanEvent; size: number; mtimeMs: number }>;
  update(filename: string, payload: MikanEvent): Promise<{ path: string; size: number }>;
  delete(filename: string): Promise<{ deleted: boolean }>;
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
