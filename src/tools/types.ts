import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { MikanEvent } from "../types.js";

// ── platform tool packs ───────────────────────────────────────────────────────

/**
 * Per-run context for optional platform-contributed tools (e.g. GitHub PR/CI).
 * Core agent code binds packs without knowing which platform owns them.
 */
interface PlatformToolRunContext {
  conversationId: string;
  platformName: string;
}

/**
 * A platform capability pack: extra tools plus a bind hook that enables or
 * disables them for the current run. Packs are assembled at process start
 * (main.ts) and injected into runners; they must not be hardcoded in the
 * core tool list.
 */
export interface PlatformToolPack {
  tools: AgentTool<TSchema>[];
  bindRun(ctx: PlatformToolRunContext): void;
}

/**
 * Injected as factories, not instances: bindRun mutates closure state inside
 * the pack's tools, so a pack must be private to one runner (whose runs are
 * serialized). A single shared instance would let concurrent conversations
 * rebind each other mid-run — routing github_pr to the wrong conversation.
 */
export type PlatformToolPackFactory = () => PlatformToolPack;

// ── event tool ───────────────────────────────────────────────────────────────

export type EventPayload = MikanEvent;

export interface EventStore {
  write(filename: string, payload: MikanEvent): Promise<{ path: string; size: number }>;
  /**
   * List all event files. Entries whose JSON cannot be parsed are kept with a
   * `null` payload so consumers (e.g. the admin portal) can still surface and
   * delete them; files that disappear mid-listing are skipped.
   */
  list(): Promise<
    Array<{ filename: string; payload: MikanEvent | null; size: number; mtimeMs: number }>
  >;
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
