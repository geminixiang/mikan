import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";

// ── platform tool packs ───────────────────────────────────────────────────────

/**
 * Per-run context for optional platform-contributed tools (e.g. GitHub PR/CI).
 * Core agent code binds packs without knowing which platform owns them.
 */
export interface PlatformToolRunContext {
  conversationId: string;
  platformName: string;
  threadTs?: string;
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

export type EventPayload = EventFilePayload;

export interface EventStore {
  write(filename: string, payload: EventFilePayload): Promise<{ path: string; size: number }>;
  /**
   * List all event files. Entries whose JSON cannot be parsed or fail format
   * validation are kept with a `null` payload so consumers (e.g. the admin
   * portal) can still surface and delete them; files that disappear
   * mid-listing are skipped.
   */
  list(): Promise<
    Array<{ filename: string; payload: EventFilePayload | null; size: number; mtimeMs: number }>
  >;
  read(
    filename: string,
  ): Promise<{ filename: string; payload: EventFilePayload; size: number; mtimeMs: number }>;
  update(filename: string, payload: EventFilePayload): Promise<{ path: string; size: number }>;
  delete(filename: string): Promise<{ deleted: boolean }>;
}

export type EventConversationKind = "direct" | "shared";

export type EventType = "immediate" | "one-shot" | "periodic";

interface EventPayloadBase {
  /** Target platform; may be omitted when only one platform is running. */
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  /** Self-contained task text; event runs do not inherit conversation history. */
  text: string;
}

export interface ImmediateEventPayload extends EventPayloadBase {
  type: "immediate";
}

export interface OneShotEventPayload extends EventPayloadBase {
  type: "one-shot";
  /** ISO 8601 timestamp with offset. */
  at: string;
}

export interface PeriodicEventPayload extends EventPayloadBase {
  type: "periodic";
  /** Cron expression (croner syntax). */
  schedule: string;
  /** IANA timezone, e.g. "Asia/Taipei". */
  timezone: string;
}

/** Wire shape of one event file. */
export type EventFilePayload = ImmediateEventPayload | OneShotEventPayload | PeriodicEventPayload;

export interface EventPayloadInput {
  type: EventType;
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  text: string;
  at?: string;
  schedule?: string;
  timezone?: string;
}
