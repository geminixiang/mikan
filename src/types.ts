import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ImmediateEventPayload,
  OneShotEventPayload,
  PeriodicEventPayload,
} from "./harness/event-format.js";
import type { SubagentRunStatus } from "./harness/types.js";
import type { SessionViewTokenStoreLike } from "./commands/types.js";
import type { MikanModels } from "./harness/models.js";
import type { McpServerConfig } from "./mcp/types.js";
import type { Office } from "./office/types.js";
import type { DockerContainerManager } from "./provisioner.js";
import type { SandboxConfig } from "./sandbox/types.js";
import type { ResolvedSessionScope } from "./sessions/types.js";
import type { PlatformToolPackFactory } from "./tools/types.js";
import type { VaultManager } from "./vault/types.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

// ── adapter ───────────────────────────────────────────────────────────────────

export type ConversationKind = "direct" | "shared";

export type PlatformName = "slack" | "discord" | "telegram" | "github";

/** Canonical platform-plus-raw identifier for one conversation office. */
export interface OfficeAddress {
  readonly platform: PlatformName;
  readonly conversationId: string;
}

/** Stable, filesystem-safe identity derived from an OfficeAddress. */
export type OfficeKey = string & { readonly __brand: "OfficeKey" };

export type OfficeMigrationStatus = "needs-owner" | "prepared" | "moving" | "committed" | "failed";

export interface OfficeMigrationRecord {
  readonly rawConversationId: string;
  readonly sourceDir: string;
  readonly workspaceRoot: string;
  readonly ownerPlatform?: PlatformName;
  readonly targetDir?: string;
  readonly status: OfficeMigrationStatus;
  readonly error?: string;
  readonly updatedAt: string;
}

/**
 * Directory entry for one conversation office. The workspace dir name stops
 * carrying the raw platform id once the ADR 0005 layout migration lands, so
 * the registry is the durable raw-id ↔ office mapping used for enumeration.
 */
export interface OfficeRecord {
  readonly platform: PlatformName;
  readonly conversationId: string;
  readonly recordedAt: string;
}

export interface OfficeRegistryState {
  readonly version: 1;
  readonly enabledPlatforms: readonly PlatformName[];
  readonly offices: readonly OfficeRecord[];
  readonly migrations: readonly OfficeMigrationRecord[];
}

export interface OfficeMigrationPreparation {
  readonly rawConversationId: string;
  readonly sourceDir: string;
  readonly workspaceRoot: string;
  readonly ownerPlatform?: PlatformName;
}

/**
 * Who can drive conversations on a platform — gates ambient credential policy.
 *
 * - `membership`: only invited workspace/server members (Slack/Discord/Telegram).
 *   Safe to copy `sandbox.defaultSharedVault` into new conversation vaults.
 * - `open-trigger`: broader trigger surface (e.g. GitHub repo writers on public
 *   issues/PRs). Ambient shared vault must not apply; use host-side platform
 *   identity or an explicitly provisioned vault.
 */
export type PlatformTrustModel = "membership" | "open-trigger";

export interface ConversationMessage {
  id: string;
  /** Canonical identity of the conversation office. */
  address: OfficeAddress;
  /** @deprecated Use address.conversationId except at platform I/O seams. */
  conversationId?: string;
  sessionKey: string;
  conversationKind: ConversationKind;
  userId: string;
  userName?: string;
  text: string;
  attachments?: { name: string; localPath: string }[];
  threadTs?: string;
}

export interface ChatToolResult {
  toolName: string;
  label?: string;
  args?: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

/**
 * Derived from the run status rather than restated, so a new terminal status
 * in the harness reaches the dashboard instead of silently rendering as a
 * status the marker tables never learned about.
 */
export type SubagentProgressStatus = SubagentRunStatus | "pending" | "running" | "skipped";

export interface SubagentProgressNode {
  id: string;
  label: string;
  status: SubagentProgressStatus;
  /** Profile the node ran under; the first thing to check when a run is ungrounded. */
  profile?: string;
  turns?: number;
  toolCalls?: number;
  toolCallCounts?: Record<string, number>;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  /**
   * What the node is doing right now, for running nodes only.
   *
   * Without it a node reports nothing between "started" and "finished", so a
   * step that legitimately takes minutes is indistinguishable from a hang —
   * and when it does finish, there is no record of how it got there.
   */
  activity?: string;
  reason?: string;
  cleanupPending?: boolean;
}

export interface SubagentProgressSnapshot {
  mode: "single" | "parallel" | "dag";
  nodes: SubagentProgressNode[];
}

export interface ConversationResponder {
  respond(text: string): Promise<void>;
  appendResponseDelta?(delta: string): Promise<void>;
  finishResponse?(finalText?: string): Promise<void>;
  replaceResponse(text: string, options?: { createOverflowLink?: () => string }): Promise<void>;
  /**
   * Override only to convert the subagent dashboard for a pipeline that is
   * not response-source Markdown (Telegram HTML). Absent, the harness composes
   * the Markdown dashboard — optionally followed by the final answer — through
   * `replaceResponse`.
   */
  replaceSubagentProgress?(progress: SubagentProgressSnapshot, finalText?: string): Promise<void>;
  respondDiagnostic(text: string, options?: { style?: "muted" | "error" }): Promise<void>;
  respondToolResult(result: ChatToolResult): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  /**
   * React to the message that triggered this run with an emoji short name
   * (no colons). Optional: platforms/contexts without reaction support omit
   * it, and callers must handle its absence.
   */
  react?(emoji: string): Promise<void>;
  deleteResponse(): Promise<void>;
}

export interface MessagingInfo {
  name: string;
  /** Stable platform workspace/team identity when the adapter has one. */
  workspaceId?: string;
  formattingGuide: string;
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
  /**
   * Trust boundary for ambient credentials and host-side MCP capabilities.
   * Built-in product paths normalize omission to `membership`; open-trigger
   * platforms set this explicitly so policy does not key off platform names.
   */
  trustModel?: PlatformTrustModel;
  diagnostics?: {
    showUsageSummary?: boolean;
  };
}

export type AgentEventPayload =
  | { kind: "sessionStart" }
  | { kind: "responseDelta"; delta: string }
  | { kind: "responseFinal"; text: string }
  | { kind: "diagnostic"; text: string }
  | { kind: "toolStart"; toolId: string; toolName: string; input?: unknown }
  | { kind: "toolEnd"; toolId: string }
  | { kind: "turnEnd"; awaitingInput?: boolean }
  | { kind: "sessionEnd"; reason?: string };

export interface AgentEventEnvelope {
  source: "mikan";
  sessionId: string;
  actorName: string;
  event: AgentEventPayload;
}

/**
 * A platform-agnostic event (message/mention) that triggers the agent.
 */
export interface ConversationEvent {
  type: string;
  /** Canonical identity created by the platform adapter at intake. */
  address: OfficeAddress;
  /** @deprecated Raw platform identifier; valid only at adapter I/O seams. */
  conversationId: string;
  /** Optional alternate conversation identity used for vault routing. */
  vaultConversationId?: string;
  /** Cross-platform conversation shape: direct message vs shared space */
  conversationKind: ConversationKind;
  /** Message timestamp or ID as string */
  ts: string;
  /** Parent message ID for threaded replies (optional) */
  thread_ts?: string;
  /** User ID */
  user: string;
  /** Message text (already stripped of bot mentions) */
  text: string;
  /** Downloaded attachments */
  attachments?: { name: string; localPath: string }[];
  /** Platform-computed session key; overrides default conversationId:thread_ts computation */
  sessionKey?: string;
}

/**
 * Minimum interface that every platform bot must implement,
 * used by the central handler in main.ts and by EventsWatcher.
 */
export interface MessagingBot {
  start(): Promise<void>;
  postMessage(channel: string, text: string): Promise<string>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  /**
   * Add an emoji reaction to a message. `emoji` is a platform-agnostic short
   * name without colons (e.g. "eyes", "white_check_mark"). Optional so
   * adapters adopt it incrementally; callers must handle its absence.
   */
  addReaction?(channel: string, messageTs: string, emoji: string): Promise<void>;
  /**
   * Upload a host-side file into a conversation. Optional so adapters adopt
   * it incrementally; callers must handle its absence. Existing adapter
   * implementations (Slack/Discord/Telegram) already match this shape.
   */
  uploadFile?(channel: string, filePath: string, title?: string): Promise<void>;
  /**
   * Post into a platform thread. Optional so adapters adopt it incrementally;
   * callers must handle its absence.
   */
  postInThread?(channel: string, threadTs: string, text: string): Promise<string>;
  /**
   * Open (or resolve) the direct-message conversation with a user, returning
   * its conversation id — usable with `postMessage`. Optional capability.
   */
  openDirectConversation?(userId: string): Promise<string>;
  /**
   * Fetch recent messages from a conversation, oldest first. Optional
   * capability; adapters may cap `limit` below what the caller asks for.
   */
  fetchHistory?(
    channel: string,
    options?: PlatformHistoryOptions,
  ): Promise<PlatformHistoryMessage[]>;
  /** List the platform workspace's active users. Optional capability. */
  listUsers?(): Promise<PlatformUserInfo[]>;
  enqueueEvent(event: ConversationEvent): boolean;
  getMessagingInfo(): MessagingInfo;
  postPrivate?(conversationId: string, userId: string, text: string): Promise<void>;
  postPrivateDiagnostic?(
    conversationId: string,
    userId: string,
    text: string,
    options?: { style?: "muted" | "error" },
  ): Promise<void>;
}

/** Filters for a platform conversation-history fetch. */
export interface PlatformHistoryOptions {
  /** Only messages strictly newer than this platform message id/timestamp. */
  oldest?: string;
  /** Maximum number of messages to return (adapters may cap this lower). */
  limit?: number;
  /**
   * Read the replies inside this thread instead of the conversation's
   * top-level messages. The thread parent itself is not returned — the result
   * is the replies to it. Adapters without threads ignore this.
   */
  threadTs?: string;
}

/** One platform message returned by a history fetch. */
export interface PlatformHistoryMessage {
  ts: string;
  threadTs?: string;
  userId?: string;
  userName?: string;
  text: string;
  isBot: boolean;
}

/** One platform user returned by a workspace user listing. */
export interface PlatformUserInfo {
  id: string;
  userName: string;
  displayName: string;
  isBot: boolean;
}

/** Normalized platform data and reply hook for one event. */
export interface ConversationContext {
  /** Canonical identity for the office handling this turn. */
  address: OfficeAddress;
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
}

export interface RunningSession {
  /** The office this run belongs to; two platforms may share a raw id. */
  address: OfficeAddress;
  sessionKey: string;
  startedAt: number;
  lastActivityAt?: number;
  currentTool?: string;
}

export interface HandleNewCommandOptions {
  sessionKey: string;
  conversationId: string;
  bot: MessagingBot;
  message: ConversationMessage;
}

/**
 * Runtime state is addressed by an office plus that office's platform session
 * reference. The session key alone is a platform value and is not unique
 * across platforms, so every session-scoped call carries its `OfficeAddress`.
 */
export interface MessagingEventHandler {
  isRunning(address: OfficeAddress, sessionKey: string): boolean;
  getRunningSessions(): RunningSession[];
  handleEvent(
    event: ConversationEvent,
    bot: MessagingBot,
    context: ConversationContext,
  ): Promise<void>;
  handleStop(address: OfficeAddress, sessionKey: string, bot: MessagingBot): Promise<void>;
  forceStop(address: OfficeAddress, sessionKey: string): void;
  handleNewCommand(options: HandleNewCommandOptions): Promise<void>;
}

// ── agent ─────────────────────────────────────────────────────────────────────

export interface PiAgentWrapper {
  syncChatHistory(currentMessageId?: string): Promise<void>;
  run(
    message: ConversationMessage,
    responder: ConversationResponder,
    platform: MessagingInfo,
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  abort(): void;
  getCurrentStep(): { toolName?: string; label?: string } | undefined;
  dispose(): Promise<void>;
}

// ── config ────────────────────────────────────────────────────────────────────

export type WorkspaceDoorPolicy = "isolated" | "trusted";
export type WorkspaceLayout = "conversation" | "shared-support" | "full";
/** An explicit office door-policy selection. */
export type WorkspacePolicyChoice =
  | { doorPolicy: "isolated" }
  | { doorPolicy: "trusted"; layout: "full" }
  | { doorPolicy: "trusted"; layout: "shared-support"; visibility?: WorkspaceVisibility };
/**
 * Read/write posture for the workspace-global MEMORY.md a `shared-support`
 * office mounts, modeled on Claude Tag's public/private channel memory:
 * `public` offices read and write it (today's default, unchanged behavior);
 * `private` offices read it but cannot write it, so information can flow in
 * from the shared pool but never leak out through a single trusted-but-
 * private office. Meaningless for `full` layout, which mounts the whole
 * workspace read-write as one bind and has no separate memory file to gate.
 */
export type WorkspaceVisibility = "public" | "private";

interface WorkspaceSettings {
  doorPolicy?: WorkspaceDoorPolicy;
  layout?: WorkspaceLayout;
  visibility?: WorkspaceVisibility;
}

export interface SandboxSettings {
  cpus?: string;
  memory?: string;
  boost?: { cpus?: string; memory?: string };
  /** Legacy image-specific workspace setting; new installations use workspace. */
  image?: { workspaceMount?: "private" | "full" };
  /** Backend-neutral office data policy and layout. */
  workspace?: WorkspaceSettings;
  defaultSharedVault?: string;
}

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  sentryDsn?: string;
  sandbox?: SandboxSettings;
  slack?: {
    replyMode?: "top-level" | "thread";
  };
  /**
   * Package sources (see `src/packages`) declared by ONE scope. Unlike every
   * other key here, packages are additive across scopes rather than
   * overriding: a conversation's list does not replace the global list, it
   * extends it. `resolveConversationSettings` therefore reports only the
   * conversation's own entries — combining the two scopes (and resolving
   * same-package collisions in the conversation's favour) is
   * `resolveConversationPackages`'s job.
   */
  packages?: string[];
  /**
   * MCP servers available to this scope, keyed by server name. Global and
   * conversation entries merge per key (conversation wins); an entry with
   * `disabled: true` turns off the inherited server. See `src/mcp`.
   */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export interface AutoReplyConfig {
  enabled: boolean;
  rules: string[];
}

export interface JudgeModelConfig {
  provider: string;
  model: string;
}

// ── context ───────────────────────────────────────────────────────────────────

/**
 * Platform conversation history entry from log.jsonl.
 */
export interface ConversationLogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  user?: string;
  userName?: string;
  text?: string;
  isMessagingBot?: boolean;
}

// ── events ────────────────────────────────────────────────────────────────────
// The wire format (payload union, schema, parser, builder) is owned by
// src/harness/event-format.ts. These are the *resolved* runtime shapes: the
// EventsWatcher fills in the platform default and infers the conversation
// kind before an event reaches a bot.

interface ResolvedEventFields {
  platform: string;
  conversationKind: ConversationKind;
}

export type ImmediateEvent = ImmediateEventPayload & ResolvedEventFields;

export type OneShotEvent = OneShotEventPayload & ResolvedEventFields;

export type PeriodicEvent = PeriodicEventPayload & ResolvedEventFields;

export type MikanEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export interface PeriodicEventInfo {
  filename: string;
  platform: string;
  conversationId: string;
  conversationKind: ConversationKind;
  text: string;
  schedule: string;
  timezone: string;
  nextRun: string | null;
}

// ── execution-resolver ────────────────────────────────────────────────────────

export interface ActorContext {
  /** Canonical office identity; vault and package keys use its raw id. */
  address: OfficeAddress;
  userId: string;
  /** From MessagingInfo.trustModel; vault policy uses this, not platform name. */
  trustModel?: PlatformTrustModel;
}

export type ImageWorkspaceMountMode = "private" | "full";

// ── log ───────────────────────────────────────────────────────────────────────

export interface LogContext {
  conversationId: string;
  userName?: string;
  conversationName?: string;
  sessionId?: string;
}

// ── portal shell (src/web/portal-shell.ts) ────────────────────────────────────

type PortalView = "admin" | "session" | "vault";

export interface PortalShellOptions {
  activeView: PortalView;
  pageTitle: string;
  identity?: {
    primary: string;
    secondary?: string;
  };
  conversationSwitcher?: {
    currentId: string;
    options?: Array<{ id: string; label: string; running?: boolean }>;
  };
  navLinks?: Partial<Record<PortalView, string>>;
  body: string;
  extraStyles?: string;
  inlineScript?: string;
  extraHead?: string;
  bodyAttributes?: Record<string, string>;
}

// ── provisioner ───────────────────────────────────────────────────────────────

/** Rewrites one Docker bind spec (`src:dst[:ro]`) during layout migration. */
export type ContainerBindTranslator = (bindSpec: string) => string;

export interface ContainerMount {
  source: string;
  target: string;
  /**
   * Mount without write access. Used for content the host owns and the agent
   * must not edit — package-provided skills, whose host copy is a git checkout
   * that a reinstall replaces wholesale. Absent means read-write, which is the
   * right default for everything the agent is meant to author.
   */
  readOnly?: boolean;
}

export interface ResourceLimits {
  cpus?: string;
  memory?: string;
}

export interface SandboxLimitStatus {
  limits?: ResourceLimits;
  boosted: boolean;
}

export interface SandboxResourceController {
  boost(key: string): Promise<SandboxLimitStatus>;
  setLimits(key: string, limits: ResourceLimits): Promise<SandboxLimitStatus>;
  getLimitStatus(key: string): SandboxLimitStatus;
  getDefaultLimits(): ResourceLimits | undefined;
  getBoostLimits(): ResourceLimits | undefined;
}

export interface ProvisionOptions {
  containerName?: string;
  mounts?: ContainerMount[];
  conversationId?: string;
}

export interface DockerContainerManagerOptions {
  limits?: ResourceLimits;
  boostLimits?: ResourceLimits;
  execFileImpl?: ExecFileAsync;
}

export interface ExecutionPlan {
  credentialKey: string;
  resourceKey: string;
  sandboxConfig: SandboxConfig;
  env?: Record<string, string>;
  mounts: ContainerMount[];
}

// ── store ─────────────────────────────────────────────────────────────────────

export interface Attachment {
  original: string;
  localPath: string;
}

// ── trigger ───────────────────────────────────────────────────────────────────

export type TriggerIntent = "mention" | "direct" | "thread-continuation" | "auto-reply-candidate";

export type TriggerResult = { trigger: true; reason: string } | { trigger: false; reason: string };

/**
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export type AutoReplyJudge = (input: {
  event: ConversationEvent;
  rules: string[];
  office: Office;
}) => Promise<boolean>;

// ── shared implementation contracts ─────────────────────────────────────────

interface EnvVarSpec {
  name: string;
  required?: boolean;
  secret?: boolean;
  deploy?: boolean;
  doc: string;
}

/** The onboarding wizard's LLM answer, applied to the settings template. */
export interface OnboardLlmChoice {
  provider: string;
  model: string;
  /** Auto-reply judge model; defaults to the main model. */
  autoReplyModel?: string;
}

export interface EnvGroup {
  key: string;
  title: string;
  kind: "platform" | "feature";
  vars: EnvVarSpec[];
  anyOf?: readonly string[];
  doc?: string;
}

export interface RunnerCacheControl {
  switchConversationModel(address: OfficeAddress, provider: string, model: string): boolean;
  /** Clear the office's cached runner for a non-model settings change; false while busy. */
  refreshConversationEnvironment(address: OfficeAddress): boolean;
}

export interface GlobalRunnerCacheControl {
  refreshAllConversations(): { busy: OfficeAddress[] };
}

export type SettingsApplyResult =
  | { ok: true; runtimeSwitched: boolean | null }
  | { ok: false; reason: "busy" };

export interface CreateRunnerOptions {
  sandboxConfig: SandboxConfig;
  sessionKey: string;
  /** The Conversation office this runner serves; identity and layout derive from it. */
  office: Office;
  /**
   * Fixed trust boundary for this office. It is not part of runner cache
   * identity; changing it requires runner replacement, not another cache entry.
   */
  trustModel: PlatformTrustModel;
  /** Platform workspace/team identity used by host-side integration provisioning. */
  platformWorkspaceId?: string;
  sessionScope: ResolvedSessionScope;
  vaultManager?: VaultManager;
  provisioner?: DockerContainerManager;
  resourceController?: SandboxResourceController;
  sessionView?: {
    tokenStore: SessionViewTokenStoreLike;
    portalBaseUrl?: string;
  };
  platformToolPackFactories?: readonly PlatformToolPackFactory[];
  models?: MikanModels;
}
