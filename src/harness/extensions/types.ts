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
 * Hooks run in registration order. Result semantics are per hook:
 * `tool_call` keeps v1's first-non-undefined-wins; `before_agent_start`,
 * `context`, `message_end`, and `tool_result` chain — each handler sees the
 * event as rewritten by earlier handlers, and for `before_agent_start` a
 * `block` from any handler wins. Hook errors are logged and never crash a run.
 */
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type { EventFilePayload, MikanSkill } from "../types.js";
import type { ExtensionRegistry } from "./registry.js";
import type {
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  CompactionEntry,
} from "../types.js";
import type {
  OfficeAddress,
  PlatformHistoryMessage,
  PlatformHistoryOptions,
  PlatformUserInfo,
} from "../../types.js";

/**
 * Platform provenance of the run a hook event belongs to. Interactive runs
 * carry the triggering message's identity (usable with `api.react` and for
 * per-user policy); autonomous runs (schedules/events) have no triggering
 * platform message, so only `kind` and `platform` are set.
 */
export interface RunOrigin {
  kind: "interactive" | "event";
  /** Platform adapter name serving this run (e.g. "slack"). */
  platform?: string;
  /** Platform message id of the triggering message; pass to `api.react`. */
  messageTs?: string;
  userId?: string;
  userName?: string;
  threadTs?: string;
  /** Attachments already downloaded to host paths (extensions run on host). */
  attachments?: { name: string; localPath: string }[];
}

export interface BeforeAgentStartHookEvent {
  prompt: string;
  images?: ImageContent[];
  systemPrompt: string;
  origin?: RunOrigin;
}

export interface BeforeAgentStartHookResult {
  /** Replace the system prompt for this turn. */
  systemPrompt?: string;
  /** Rewrite the user prompt for this turn. */
  prompt?: string;
  /** Block the turn entirely; the model is never called and nothing persists. */
  block?: boolean;
  /** Shown to the user when the turn is blocked. */
  reason?: string;
}

export interface ToolCallHookEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
  origin?: RunOrigin;
}

export interface ToolCallHookResult {
  /** Block the tool call; the model receives an error tool result instead. */
  block?: boolean;
  reason?: string;
}

export interface ContextHookEvent {
  /** A call-local clone of the transcript about to be sent to the LLM. */
  messages: AgentMessage[];
  origin?: RunOrigin;
}

export interface ContextHookResult {
  /** Replace the messages sent for this LLM call only. */
  messages?: AgentMessage[];
}

export interface ToolResultHookEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
  content: (TextContent | ImageContent)[];
  details: unknown;
  isError: boolean;
  /** Usage from the tool execution itself, if available. */
  usage?: Usage;
  origin?: RunOrigin;
}

export interface ToolResultHookResult {
  /** Replace the tool result content sent back to the model (e.g. redaction). */
  content?: (TextContent | ImageContent)[];
  /** Replace the structured tool result details. */
  details?: unknown;
  /** Override the tool result error flag. */
  isError?: boolean;
  /** Replace usage reported by the tool execution. */
  usage?: Usage;
}

export interface MessageEndHookEvent {
  message: AgentMessage;
  origin?: RunOrigin;
}

export interface MessageEndHookResult {
  /** Replace the finalized message. The replacement must keep the original role. */
  message?: AgentMessage;
}

export interface TurnEndHookEvent {
  messages: AgentMessage[];
  origin?: RunOrigin;
}

export interface SessionCompactHookEvent {
  entry: CompactionEntry;
  reason: "threshold" | "overflow" | "manual";
}

/** A turn settled with an error after retries were exhausted (or none applied). */
export interface AgentErrorHookEvent {
  errorMessage: string;
  origin?: RunOrigin;
}

/** The run budget circuit breaker tripped and the run was aborted. */
export interface BudgetExceededHookEvent {
  /** Which cap was hit, e.g. "cost 2.01 USD >= 2 USD limit". */
  reason: string;
  tokens: number;
  costUsd: number;
  llmCalls: number;
  durationMs: number;
  origin?: RunOrigin;
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
  context: (
    event: ContextHookEvent,
  ) => ContextHookResult | undefined | void | Promise<ContextHookResult | undefined | void>;
  tool_result: (
    event: ToolResultHookEvent,
  ) => ToolResultHookResult | undefined | void | Promise<ToolResultHookResult | undefined | void>;
  message_end: (
    event: MessageEndHookEvent,
  ) => MessageEndHookResult | undefined | void | Promise<MessageEndHookResult | undefined | void>;
  turn_end: (event: TurnEndHookEvent) => void | Promise<void>;
  session_compact: (event: SessionCompactHookEvent) => void | Promise<void>;
  agent_error: (event: AgentErrorHookEvent) => void | Promise<void>;
  budget_exceeded: (event: BudgetExceededHookEvent) => void | Promise<void>;
}

export type MikanHookName = keyof MikanHookMap;

// ── v2: schedules ────────────────────────────────────────────────────────────

/**
 * What a schedule does when it fires — exactly one of:
 *
 * - `text`: an autonomous agent run in this conversation with `text` as the
 *   task prompt (the run does not inherit conversation history — write it
 *   self-contained).
 * - `callback`: a deterministic host-side handler registered with
 *   `api.schedules.onCallback` — no agent run, no model call. `args` is
 *   stored with the schedule and passed to the handler on every fire.
 */
export type ExtensionScheduleAction =
  | {
      text: string;
      /** Target platform; defaults to this conversation's own. */
      platform?: string;
      callback?: never;
      args?: never;
    }
  | {
      /** Name of a callback registered with `api.schedules.onCallback`. */
      callback: string;
      /** JSON-serializable payload passed to the callback on each fire. */
      args?: unknown;
      text?: never;
      platform?: never;
    };

/** A schedule contributed by an extension. */
export type ExtensionScheduleSpec =
  | ({
      type: "periodic";
      /** Cron expression (croner syntax). */
      schedule: string;
      /** IANA timezone, e.g. "Asia/Taipei". */
      timezone: string;
    } & ExtensionScheduleAction)
  | ({
      type: "one-shot";
      /** ISO 8601 timestamp with offset. */
      at: string;
    } & ExtensionScheduleAction);

/** The callback-actioned subset of {@link ExtensionScheduleSpec}. */
export type ExtensionCallbackScheduleSpec = Extract<ExtensionScheduleSpec, { callback: string }>;

/** The agent-run (text) subset of {@link ExtensionScheduleSpec}. */
export type ExtensionTextScheduleSpec = Exclude<ExtensionScheduleSpec, { callback: string }>;

export interface ExtensionScheduleInfo {
  /** Extension-chosen schedule name. */
  name: string;
  spec: ExtensionScheduleSpec;
}

/** One fire of a callback-actioned schedule, as seen by the handler. */
export interface ExtensionScheduleCallbackEvent {
  /** Name of the schedule that fired. */
  scheduleName: string;
  /** The `args` stored on the schedule spec, if any. */
  args?: unknown;
}

export type ExtensionScheduleCallbackHandler = (
  event: ExtensionScheduleCallbackEvent,
) => void | Promise<void>;

/**
 * Event-file payload the harness hands to the embedder's schedule store —
 * the canonical event-file shape owned by the event-format module.
 * `platform` may be omitted when the embedder runs a single platform.
 * `immediate` backs `api.triggerRun` — the event fires as soon as the
 * embedder's watcher picks it up.
 */
export type ExtensionSchedulePayload = EventFilePayload;

// ── v3: commands and lifecycle ───────────────────────────────────────────────

/** Cleanup callback run when the harness instance owning the extension is discarded. */
export type ExtensionDisposer = () => void | Promise<void>;

/** Context handed to an extension command handler for one invocation. */
export interface ExtensionCommandContext {
  /** Text after the command name, trimmed ("" when none). */
  args: string;
  conversationId: string;
  userId?: string;
  userName?: string;
  /**
   * Platform thread the command was sent from, when threaded. Pass to
   * `blockkit.post` so interactive messages land in the same thread.
   */
  threadTs?: string;
  /** Reply in the conversation the command was sent from. */
  respond(text: string): Promise<void>;
}

/**
 * A chat command contributed by an extension (`/name args…`). Dispatched
 * deterministically by the embedder — no model call, no agent-session entry
 * (the triggering message still syncs to chat history).
 * Built-in commands always win over extension commands of the same name.
 */
export interface ExtensionCommand {
  /** Command name without the leading slash; `[a-z0-9_-]+`, case-insensitive match. */
  name: string;
  /** One-line description for inventory surfaces. */
  description?: string;
  handler: (context: ExtensionCommandContext) => void | Promise<void>;
}

// ── blockkit: interactive platform surfaces ──────────────────────────────────

/** One user interaction with an interactive element posted by this extension. */
export interface ExtensionBlockAction {
  /** The extension's own action id (the routing namespace is stripped). */
  actionId: string;
  /** Button value or single-select selected value. */
  value?: string;
  /** Selected option values for multi-selects and checkboxes. */
  selectedValues?: string[];
  userId?: string;
  userName?: string;
  conversationId: string;
  /** Platform message id of the interactive message; pass to `blockkit.update`. */
  messageTs?: string;
  threadTs?: string;
}

export type ExtensionBlockActionHandler = (action: ExtensionBlockAction) => void | Promise<void>;

/** Platform-native interactive message content (Slack Block Kit blocks). */
export interface ExtensionBlockKitMessage {
  /** Plain-text fallback for notifications and screen readers. */
  text: string;
  /** Block Kit blocks. `post` namespaces every action_id with the extension slug. */
  blocks: object[];
  /** Post into this platform thread; omit for a top-level message. */
  threadTs?: string;
}

export interface SubagentApi {
  /**
   * Run one fresh subagent and return its result to the extension. The
   * subagent has no conversation history, receives no tools by default, and
   * cannot recursively start another subagent run. Never rejects: every
   * failure, including request validation, resolves to a result with a
   * terminal status.
   */
  run<TOutputSchema extends TSchema | undefined = undefined>(
    request: SubagentRunRequest<TOutputSchema>,
  ): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>>;
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
 * Persistence + arming backend for callback-actioned schedules, injected by
 * the embedder scoped to one conversation. Unlike {@link ExtensionScheduleStore}
 * (the agent-writable workspace event bus), this store must be
 * host-authoritative: a fired callback crosses into trusted host code, so
 * sandboxed agents must never be able to create or edit its entries. mikan
 * backs it with files under the host-only state dir.
 */
export interface ExtensionCallbackScheduleStore {
  upsert(slug: string, name: string, spec: ExtensionCallbackScheduleSpec): Promise<void>;
  delete(slug: string, name: string): Promise<boolean>;
  list(slug: string): Promise<ExtensionScheduleInfo[]>;
}

/**
 * Process-wide engine behind {@link ExtensionCallbackScheduleStore}: persists
 * callback schedules per conversation, arms them across restarts, and
 * dispatches fires into the owning conversation's extension registry.
 */
export interface ExtensionScheduleEngine {
  upsert(
    address: OfficeAddress,
    slug: string,
    name: string,
    spec: ExtensionCallbackScheduleSpec,
  ): Promise<void>;
  delete(address: OfficeAddress, slug: string, name: string): Promise<boolean>;
  list(address: OfficeAddress, slug: string): Promise<ExtensionScheduleInfo[]>;
}

/** One fire dispatched by the engine to the conversation runtime. */
export interface ExtensionScheduleCallbackFire {
  platform: string;
  conversationId: string;
  slug: string;
  scheduleName: string;
  callback: string;
  args?: unknown;
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
  /**
   * Post a message to a conversation without an agent run, resolving to the
   * posted message's platform id; enables `api.notify`.
   */
  postMessage?: (
    conversationId: string,
    text: string,
    options?: { platform?: string; threadTs?: string },
  ) => Promise<string>;
  /** Resolve a user's DM conversation id; enables `api.openDm`. */
  openDirectConversation?: (userId: string, platform?: string) => Promise<string>;
  /** Read recent conversation messages; enables `api.fetchHistory`. */
  fetchHistory?: (
    conversationId: string,
    options?: PlatformHistoryOptions & { platform?: string },
  ) => Promise<PlatformHistoryMessage[]>;
  /** List the platform workspace's active users; enables `api.listUsers`. */
  listUsers?: (platform?: string) => Promise<PlatformUserInfo[]>;
  /** Post an interactive Block Kit message; enables `api.blockkit.post`. */
  postBlocks?: (
    conversationId: string,
    message: { text: string; blocks: object[]; threadTs?: string },
    platform?: string,
  ) => Promise<{ ts: string }>;
  /** Update an interactive Block Kit message; enables `api.blockkit.update`. */
  updateBlocks?: (
    conversationId: string,
    messageTs: string,
    message: { text: string; blocks: object[] },
    platform?: string,
  ) => Promise<void>;
  /** Add an emoji reaction to a message; enables `api.react`. */
  addReaction?: (
    conversationId: string,
    messageTs: string,
    emoji: string,
    platform?: string,
  ) => Promise<void>;
  /** Upload a host file into a conversation; enables `api.uploadFile`. */
  uploadFile?: (
    conversationId: string,
    filePath: string,
    title?: string,
    platform?: string,
  ) => Promise<void>;
  /** Callback-schedule persistence; enables `api.schedules` callback specs. */
  callbackScheduleStore?: ExtensionCallbackScheduleStore;
  /** Resolve read-only secrets for an extension slug; enables `api.secrets`. */
  resolveSecrets?: (slug: string) => Record<string, string>;
  /** Run a fresh isolated subagent; enables `api.subagent`. */
  runSubagent?: <TOutputSchema extends TSchema | undefined = undefined>(
    request: SubagentRunRequest<TOutputSchema>,
    contributedTools: AgentTool[],
  ) => Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>>;
}

// ── v2: manifest ─────────────────────────────────────────────────────────────

/**
 * One secret an extension declares in its `package.json` (`mikan.secrets`).
 * Declarations drive provisioning surfaces (the admin portal, `mikan ext`)
 * and activation-time validation: a missing `required` secret fails that
 * extension's activation with a provisioning hint instead of a confusing
 * runtime error.
 */
export interface ExtensionSecretDeclaration {
  /** Env-style key, e.g. "SLACK_BOT_TOKEN". */
  key: string;
  /** One-line hint shown on provisioning surfaces. */
  description?: string;
  /** When true, activation fails while the secret is unprovisioned. */
  required?: boolean;
}

/**
 * Optional `manifest.json` next to a directory-form extension's entrypoint.
 * `name` is the display name only; the slug (data dir, secrets, schedule
 * ownership) always derives from the install path so identity is
 * admin-controlled and stable across manifest edits. `secrets` comes from
 * `package.json`'s `mikan.secrets` only.
 */
export interface ExtensionManifest {
  name?: string;
  version?: string;
  description?: string;
  secrets?: ExtensionSecretDeclaration[];
  /**
   * Capability names declared in package.json `mikan.requires`, as written.
   * Unknown names survive here so validation can flag them; the loader
   * classifies against the capability inventory at activation time.
   */
  requires?: string[];
}

/**
 * Host capabilities an extension can declare in `mikan.requires` and probe
 * through `api.capabilities`. Each name maps to the {@link ExtensionHostServices}
 * field(s) that back the corresponding api surface; the loader checks declared
 * requirements against the injected services BEFORE importing the module, so a
 * missing capability is one clear activation error naming the extension and
 * the gap — not a runtime throw at the first `api.*` call (ADR 0006).
 */
export type ExtensionCapability =
  | "schedules"
  | "schedules.callback"
  | "messaging"
  | "messaging.dm"
  | "messaging.history"
  | "messaging.users"
  | "messaging.reactions"
  | "messaging.uploads"
  | "blockkit"
  | "secrets"
  | "subagent";

/** Runtime capability introspection handed to extensions as `api.capabilities`. */
export interface ExtensionCapabilities {
  /** Whether this context provides the capability. */
  has(name: ExtensionCapability): boolean;
  /** Capabilities this context provides, in inventory order. */
  list(): ExtensionCapability[];
}

/** API handed to an extension's `activate` function. */
export interface MikanExtensionApi {
  /**
   * Capabilities this context provides. Prefer declaring hard requirements
   * in `mikan.requires` (checked before activation); use this for graceful
   * degradation — e.g. skip Block Kit output when `has("blockkit")` is false.
   */
  readonly capabilities: ExtensionCapabilities;
  /** Register a hook handler. */
  on<T extends MikanHookName>(hook: T, handler: MikanHookMap[T]): void;
  /** Contribute an additional agent tool. */
  registerTool(tool: AgentTool): void;
  /**
   * Contribute a chat command (`/name`). Dispatched without a model call;
   * built-in commands and earlier registrations of the same name win.
   */
  registerCommand(command: ExtensionCommand): void;
  /**
   * Register cleanup to run when this harness instance is discarded
   * (`/pi-new`, session eviction, shutdown). Alternative to returning a
   * disposer from `activate`. Disposers run in reverse registration order.
   */
  onDispose(disposer: ExtensionDisposer): void;
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
   * Named schedules owned by this extension + conversation, persisted across
   * restarts. `text` specs become event files that fire autonomous agent
   * runs; `callback` specs fire a handler registered with `onCallback` —
   * deterministic, no model call. One namespace: upserting a name switches
   * its kind atomically.
   */
  readonly schedules: {
    /** Create or replace a named schedule. */
    upsert(name: string, spec: ExtensionScheduleSpec): Promise<void>;
    /** Delete a named schedule. Returns false when it did not exist. */
    delete(name: string): Promise<boolean>;
    /** Schedules owned by this extension in this conversation. */
    list(): Promise<ExtensionScheduleInfo[]>;
    /**
     * Register the handler for callback-actioned schedules naming
     * `callbackName`. Register during `activate` so the handler exists
     * whenever a schedule fires (including right after a restart). Invalid
     * names throw; a duplicate registration keeps the first.
     */
    onCallback(callbackName: string, handler: ExtensionScheduleCallbackHandler): void;
  };
  /** Fresh isolated subagent runs. */
  readonly subagent: SubagentApi;
  /**
   * Post text into a conversation without triggering an agent run. Defaults
   * to this conversation; pass `conversationId` to post elsewhere (pairs
   * with `sharedDataDir` for cross-conversation applications). The platform
   * defaults to this conversation's own; pass `platform` only when targeting
   * a conversation on a different one. `threadTs` posts into a platform
   * thread where the adapter supports it. Available when the embedder
   * provides platform messaging.
   *
   * Resolves to the posted message's platform id — pass it back as
   * `fetchHistory({ threadTs })` to read replies to what you just posted, or
   * to `react` to annotate it.
   */
  notify(
    text: string,
    options?: { conversationId?: string; platform?: string; threadTs?: string },
  ): Promise<string>;
  /**
   * Resolve the direct-message conversation with a platform user, returning
   * a conversation id usable with `notify`/`uploadFile`. Available when the
   * embedder provides DM resolution and the platform supports it.
   */
  openDm(userId: string): Promise<string>;
  /**
   * Read recent messages from a conversation, oldest first, without an agent
   * run. Defaults to this conversation; adapters may cap `limit` and return
   * a single page — page forward by passing the last returned `ts` as
   * `oldest`. Pass `threadTs` to read the replies inside one thread instead
   * of the conversation's top-level messages (the parent is not returned).
   * Available when the embedder provides history reads.
   */
  fetchHistory(options?: {
    conversationId?: string;
    oldest?: string;
    limit?: number;
    threadTs?: string;
  }): Promise<PlatformHistoryMessage[]>;
  /**
   * List the platform workspace's active users without an agent run.
   * Available when the embedder provides user listings.
   */
  listUsers(): Promise<PlatformUserInfo[]>;
  /**
   * Interactive platform surfaces (Slack Block Kit). `post` namespaces every
   * `action_id` in the blocks with this extension's slug; interactions on
   * those elements are dispatched exclusively to `onAction` handlers — no
   * agent run, no model call. The extension decides whether to involve the
   * model afterwards (`triggerRun`). Available when the embedder provides
   * Block Kit messaging.
   */
  readonly blockkit: {
    /** Post an interactive message into this conversation. Returns its message id. */
    post(message: ExtensionBlockKitMessage): Promise<{ ts: string }>;
    /** Replace an interactive message previously posted with `post`. */
    update(messageTs: string, message: { text: string; blocks: object[] }): Promise<void>;
    /** Register a handler for interactions on this extension's elements. */
    onAction(actionId: string, handler: ExtensionBlockActionHandler): void;
  };
  /**
   * Add an emoji reaction to a message in this conversation. `messageTs` is
   * the platform message id the extension read from an event (see
   * `RunOrigin.messageTs`); `emoji` is a short name without colons.
   * Available when the embedder provides reaction support.
   */
  react(messageTs: string, emoji: string): Promise<void>;
  /**
   * Upload a host-side file into this conversation without an agent run.
   * Available when the embedder provides file uploads for the platform.
   */
  uploadFile(filePath: string, title?: string): Promise<void>;
  /**
   * Fire an autonomous agent run in this conversation as soon as possible.
   * Like a schedule, the run does not inherit conversation history — write
   * `text` self-contained. Backed by the embedder's schedule store.
   */
  triggerRun(text: string): Promise<void>;
}

export type MikanExtensionActivate = (
  api: MikanExtensionApi,
) => void | ExtensionDisposer | Promise<void | ExtensionDisposer>;

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

/** Discovery-only view of an installed extension (module is not imported). */
export interface InstalledExtensionInfo {
  /** Display name: manifest name, falling back to the slug. */
  name: string;
  slug: string;
  path: string;
  /** Scan directory the extension was found in. */
  dir: string;
  version?: string;
  description?: string;
  /** Names of skills shipped in the extension's skills/ directory. */
  skillNames: string[];
  /** Secrets declared in package.json `mikan.secrets`. */
  secrets: ExtensionSecretDeclaration[];
}

export interface LoadExtensionsOptions {
  /**
   * Directories to scan for extensions, in ascending precedence. Missing
   * directories are skipped. When two directories contribute the same slug,
   * the later one wins — that is how a conversation-scoped copy of a package
   * shadows the global one instead of activating alongside it.
   */
  dirs: string[];
  /**
   * Extension roots to load directly, without scanning for children. Each
   * path is one extension (a directory with an entrypoint, or a bare file).
   * Highest precedence, after every scanned directory. This is what
   * `mikan ext dev` points at a working copy.
   */
  roots?: string[];
  context: {
    /** Office identity; host-only state keys derive from it. */
    address: OfficeAddress;
    /** Raw platform id — what extension code sees and platform APIs accept. */
    conversationId: string;
    workspaceDir: string;
    model: Model<Api>;
    thinkingLevel: ThinkingLevel;
  };
  /** Embedder-provided services backing the v2 api surface. */
  services?: ExtensionHostServices;
}

export interface LoadExtensionsResult {
  registry: ExtensionRegistry;
  extensions: LoadedExtension[];
  errors: ExtensionLoadError[];
  /** Skills contributed by extensions (inline: bodies ride in the prompt). */
  skills: MikanSkill[];
  /**
   * Run extension disposers (from `api.onDispose` and `activate` return
   * values). Call when the harness instance owning these extensions is
   * discarded. Idempotent; disposer errors are logged, never thrown.
   */
  dispose(): Promise<void>;
}

export interface ExtensionValidation {
  ok: boolean;
  /** Slug the extension would install as (from the source dir/file name). */
  slug: string;
  /** Display name (manifest name, else slug). */
  name: string;
  version?: string;
  description?: string;
  /** Resolved entrypoint that would be imported. */
  entrypoint?: string;
  /** Skill names shipped alongside the extension. */
  skillNames: string[];
  /** Secrets declared in package.json `mikan.secrets`. */
  secrets: ExtensionSecretDeclaration[];
  /** Capability names declared in package.json `mikan.requires`, as written. */
  requires: string[];
  errors: string[];
  warnings: string[];
}
