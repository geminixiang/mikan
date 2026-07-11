/**
 * mikan extension system, v1.
 *
 * Extensions are ES modules that export an `activate` function (either as
 * the default export or a named `activate` export, optionally wrapped in an
 * object that also carries a `name`). `activate` receives a
 * {@link MikanExtensionApi} and registers hooks and tools.
 *
 * ```js
 * // extensions/audit.mjs
 * export default function activate(api) {
 *   api.on("tool_call", ({ toolName, args }) => {
 *     if (toolName === "bash" && String(args.command).includes("rm -rf /")) {
 *       return { block: true, reason: "destructive command" };
 *     }
 *   });
 * }
 * ```
 *
 * Hooks run in registration order. For hooks with results, the first
 * non-undefined result wins (v1 semantics; later versions may merge).
 * Hook errors are logged and never crash a run.
 */
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { MikanSkill } from "../skills.js";
import type { CompactionEntry } from "../types.js";

export interface BeforeAgentStartHookEvent {
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
}

export interface BeforeAgentStartHookResult {
  /** Replace the system prompt for this turn. */
  systemPrompt?: string;
}

export interface ToolCallHookEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolCallHookResult {
  /** Block the tool call; the model receives an error tool result instead. */
  block?: boolean;
  reason?: string;
}

export interface ToolResultHookEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export interface MessageEndHookEvent {
  message: AgentMessage;
}

export interface TurnEndHookEvent {
  messages: AgentMessage[];
}

export interface SessionCompactHookEvent {
  entry: CompactionEntry;
  reason: "threshold" | "overflow" | "manual";
}

/** Map of hook names to handler signatures. */
export interface MikanHookMap {
  before_agent_start: (
    event: BeforeAgentStartHookEvent,
  ) =>
    | BeforeAgentStartHookResult
    | undefined
    | void
    | Promise<BeforeAgentStartHookResult | undefined | void>;
  tool_call: (
    event: ToolCallHookEvent,
  ) => ToolCallHookResult | undefined | void | Promise<ToolCallHookResult | undefined | void>;
  tool_result: (event: ToolResultHookEvent) => void | Promise<void>;
  message_end: (event: MessageEndHookEvent) => void | Promise<void>;
  turn_end: (event: TurnEndHookEvent) => void | Promise<void>;
  session_compact: (event: SessionCompactHookEvent) => void | Promise<void>;
}

export type MikanHookName = keyof MikanHookMap;

// ── v2: schedules ────────────────────────────────────────────────────────────

/**
 * A schedule contributed by an extension. Fires an autonomous agent run in
 * this conversation with `text` as the task prompt (the run does not inherit
 * conversation history — write `text` self-contained).
 */
export type ExtensionScheduleSpec =
  | {
      type: "periodic";
      /** Cron expression (croner syntax). */
      schedule: string;
      /** IANA timezone, e.g. "Asia/Taipei". */
      timezone: string;
      text: string;
      /** Target platform; optional when only one platform is running. */
      platform?: string;
    }
  | {
      type: "one-shot";
      /** ISO 8601 timestamp with offset. */
      at: string;
      text: string;
      platform?: string;
    };

export interface ExtensionScheduleInfo {
  /** Extension-chosen schedule name. */
  name: string;
  spec: ExtensionScheduleSpec;
}

/**
 * Event-file payload the harness hands to the embedder's schedule store.
 * Mirrors mikan's event-file shape; `platform` may be omitted when the
 * embedder runs a single platform.
 */
export interface ExtensionSchedulePayload {
  type: "one-shot" | "periodic";
  conversationId: string;
  text: string;
  platform?: string;
  at?: string;
  schedule?: string;
  timezone?: string;
}

// ── v2: embedder-injected services ───────────────────────────────────────────

/**
 * Persistence backend for extension schedules, injected by the embedder
 * (mikan backs this with event files watched by its EventsWatcher).
 * Filenames are fully qualified by the harness (`ext-<slug>-<name>.json`).
 */
export interface ExtensionScheduleStore {
  write(filename: string, payload: ExtensionSchedulePayload): Promise<void>;
  delete(filename: string): Promise<boolean>;
  /** List all schedule files, harness filters by ownership prefix. */
  list(): Promise<Array<{ filename: string; payload: ExtensionSchedulePayload }>>;
}

/**
 * Host services injected into extensions by the embedder. All fields are
 * optional: the corresponding api surface throws an informative error when
 * the running context does not provide the service.
 */
export interface ExtensionHostServices {
  /** State dir for per-extension data dirs; defaults to `~/.mikan`. */
  stateDir?: string;
  /** Schedule persistence; enables `api.schedules`. */
  scheduleStore?: ExtensionScheduleStore;
  /** Post a message to a conversation without an agent run; enables `api.notify`. */
  postMessage?: (conversationId: string, text: string, platform?: string) => Promise<void>;
  /** Resolve read-only secrets for an extension slug; enables `api.secrets`. */
  resolveSecrets?: (slug: string) => Record<string, string>;
}

// ── v2: manifest ─────────────────────────────────────────────────────────────

/**
 * Optional `manifest.json` next to a directory-form extension's entrypoint.
 * `name` is the display name only; the slug (data dir, secrets, schedule
 * ownership) always derives from the install path so identity is
 * admin-controlled and stable across manifest edits.
 */
export interface ExtensionManifest {
  name?: string;
  version?: string;
  description?: string;
}

/** API handed to an extension's `activate` function. */
export interface MikanExtensionApi {
  /** Register a hook handler. */
  on<T extends MikanHookName>(hook: T, handler: MikanHookMap[T]): void;
  /** Contribute an additional agent tool. */
  registerTool(tool: AgentTool): void;
  /** Extension-scoped logging that lands in mikan's structured log. */
  log(message: string): void;
  /** Context about the conversation this harness instance serves. */
  readonly context: {
    readonly conversationId: string;
    readonly workspaceDir: string;
    readonly model: Model<Api>;
    readonly thinkingLevel: ThinkingLevel;
  };
  /**
   * Host-only filesystem locations owned by this extension (never mounted
   * into sandbox containers). Which one you use is a declaration: `dataDir`
   * for conversation-scoped state (the safe default — isolation for free),
   * `sharedDataDir` for deliberately cross-conversation state (you own tenant
   * partitioning and concurrency). See `LAYOUT.md`.
   */
  readonly paths: {
    /**
     * This conversation's private data directory
     * (`conversations/<conversationId>/extension-data/<slug>`), created on
     * first access. Default choice: co-located with the conversation, so it
     * disappears when the conversation is deleted.
     */
    readonly dataDir: string;
    /**
     * Data shared across all conversations this extension serves
     * (`global/extension-data/<slug>`), created on first access. Explicit
     * opt-in for multi-conversation applications (e.g. a PM tool with
     * cross-channel views); key rows by conversation id yourself.
     */
    readonly sharedDataDir: string;
  };
  /**
   * Read-only secrets from the embedder's vault
   * (mikan: `<stateDir>/vaults/extensions/<slug>/env`).
   */
  readonly secrets: {
    get(key: string): string | undefined;
    /** Secret names only, never values. */
    list(): string[];
  };
  /**
   * Named schedules owned by this extension + conversation. Backed by the
   * embedder's schedule store; in mikan these become event files that fire
   * autonomous agent runs (hot-reloaded, persisted across restarts).
   */
  readonly schedules: {
    /** Create or replace a named schedule. */
    upsert(name: string, spec: ExtensionScheduleSpec): Promise<void>;
    /** Delete a named schedule. Returns false when it did not exist. */
    delete(name: string): Promise<boolean>;
    /** Schedules owned by this extension in this conversation. */
    list(): Promise<ExtensionScheduleInfo[]>;
  };
  /**
   * Post text into this conversation without triggering an agent run.
   * Available when the embedder provides platform messaging.
   */
  notify(text: string): Promise<void>;
}

export type MikanExtensionActivate = (api: MikanExtensionApi) => void | Promise<void>;

export interface MikanExtensionModule {
  name?: string;
  activate: MikanExtensionActivate;
}

export interface LoadedExtension {
  name: string;
  path: string;
  /** Filesystem-safe identifier used for data dirs, secrets, and schedules. */
  slug: string;
  version?: string;
  description?: string;
  /** Skills discovered under the extension's `skills/` directory. */
  skills: MikanSkill[];
}

export interface ExtensionLoadError {
  path: string;
  error: string;
}
