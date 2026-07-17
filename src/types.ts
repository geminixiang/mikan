import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";
import type {
  ImmediateEventPayload,
  OneShotEventPayload,
  PeriodicEventPayload,
} from "./harness/event-format.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

// ── adapter ───────────────────────────────────────────────────────────────────

export type ConversationKind = "direct" | "shared";

export type PlatformName = "slack" | "discord" | "telegram" | "github";

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

export interface ConversationResponder {
  respond(text: string): Promise<void>;
  appendResponseDelta?(delta: string): Promise<void>;
  finishResponse?(finalText?: string): Promise<void>;
  replaceResponse(text: string, options?: { createOverflowLink?: () => string }): Promise<void>;
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
  formattingGuide: string;
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
  /**
   * Trust boundary for ambient credentials. Defaults to `membership` when
   * omitted (closed chat platforms). Open-trigger platforms must set this
   * explicitly so vault policy does not key off platform name strings.
   */
  trustModel?: PlatformTrustModel;
  diagnostics?: {
    showUsageSummary?: boolean;
  };
}

export interface ChatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMessagingInfo(): MessagingInfo;
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
  /** Platform-specific raw conversation/channel/chat identifier */
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

/**
 * Post a plain message to a conversation without triggering an agent run.
 * Backs extension `api.notify`; implemented in main.ts over the platform bots.
 * `platform` is required only when more than one platform is running.
 */
export type PlatformNotifier = (
  conversationId: string,
  text: string,
  platform?: string,
) => Promise<void>;

/**
 * Add an emoji reaction to a message without triggering an agent run. Backs
 * extension `api.react`; implemented in main.ts over the platform bots.
 */
export type PlatformReactor = (
  conversationId: string,
  messageTs: string,
  emoji: string,
  platform?: string,
) => Promise<void>;

/**
 * Upload a host-side file into a conversation without triggering an agent
 * run. Backs extension `api.uploadFile`; implemented in main.ts over the
 * platform bots. `platform` is required only when more than one is running.
 */
export type PlatformUploader = (
  conversationId: string,
  filePath: string,
  title?: string,
  platform?: string,
) => Promise<void>;

/** Normalized platform data and reply hook for one event. */
export interface ConversationContext {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
}

export interface RunningSession {
  sessionKey: string;
  startedAt: number;
  lastActivityAt?: number;
  currentTool?: string;
}

export interface MessagingEventHandler {
  isRunning(sessionKey: string): boolean;
  getRunningSessions(): RunningSession[];
  handleEvent(
    event: ConversationEvent,
    bot: MessagingBot,
    context: ConversationContext,
  ): Promise<void>;
  handleStop(sessionKey: string, conversationId: string, bot: MessagingBot): Promise<void>;
  forceStop(sessionKey: string): void;
  handleNewCommand(sessionKey: string, conversationId: string, bot: MessagingBot): Promise<void>;
}

// ── agent ─────────────────────────────────────────────────────────────────────

export interface PiAgentWrapper {
  syncChatHistory(currentMessageId?: string): void;
  run(
    message: ConversationMessage,
    responder: ConversationResponder,
    platform: MessagingInfo,
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  abort(): void;
  getCurrentStep(): { toolName?: string; label?: string } | undefined;
  /**
   * Dispatch a leading-slash message to an extension-registered command.
   * Returns true when a command consumed the message (no agent run follows).
   */
  tryExtensionCommand(
    message: ConversationMessage,
    responder: ConversationResponder,
  ): Promise<boolean>;
  /** Run extension disposers. Call once when this wrapper is discarded. */
  dispose(): Promise<void>;
}

// ── config ────────────────────────────────────────────────────────────────────

export interface GondolinRemoteWorkerSettings {
  /** Stable placement identity; defaults to the URL. */
  name?: string;
  /** Base URL of the mikan-worker daemon, e.g. https://worker.internal:8433 */
  url: string;
  /** CA bundle that signs the daemon's server certificate. */
  caFile?: string;
  /** Client certificate + key presented to the daemon (mTLS); falls back to the fleet-level pair. */
  certFile?: string;
  keyFile?: string;
  /** Worker-side path of the shared workspace filesystem. */
  workspaceRoot?: string;
  /** Admission cap for new placements (existing runtimes always count). */
  maxRuntimes?: number;
  /** Drained workers accept no new placements; existing ones finish out. */
  draining?: boolean;
}

export interface GondolinGatewaySettings {
  /** Port the worker gateway listens on for dial-home workers. */
  port: number;
  /**
   * Gateway server certificate + key and the CA that signs worker client
   * certificates. Omit all three to let the gateway provision its own CA and
   * server certificate under the state dir (required for `--worker-token`
   * joins).
   */
  certFile?: string;
  keyFile?: string;
  clientCaFile?: string;
  /** SANs for the auto-issued server certificate (defaults to os.hostname). */
  hostnames?: string[];
  /**
   * Worker-side path of the shared workspace filesystem. Required in practice:
   * mount sources are translated to it, and without it every runtime is
   * rejected with "escapes the workspace root". gondolinGateway.start()
   * enforces it at boot; typed optional to match the settings schema.
   */
  workspaceRoot?: string;
  /** Per-worker host-side overrides, keyed by worker name. */
  workers?: Record<string, { maxRuntimes?: number; draining?: boolean }>;
}

export interface GondolinRemoteSettings {
  /** Single-worker form: connection fields inline (a fleet of one). */
  url?: string;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  workspaceRoot?: string;
  maxRuntimes?: number;
  /** Fleet form: several workers; per-worker fields fall back to the inline ones. */
  workers?: GondolinRemoteWorkerSettings[];
  /** Dial-home form: listen for workers that connect to mikan instead. */
  gateway?: GondolinGatewaySettings;
  /** Guest image selector resolved on the workers. */
  imageSelector?: string;
  /** How long a new conversation waits for capacity before failing. */
  queueWaitSeconds?: number;
}

export interface SandboxSettings {
  cpus?: string;
  memory?: string;
  boost?: { cpus?: string; memory?: string };
  image?: { workspaceMount?: "private" | "full" };
  gondolin?: { remote?: GondolinRemoteSettings };
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
  platform: string;
  userId: string;
  conversationId: string;
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

export interface ContainerMount {
  source: string;
  target: string;
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

// ── store ─────────────────────────────────────────────────────────────────────

export interface Attachment {
  original: string;
  localPath: string;
}

export interface LoggedMessage {
  date: string;
  ts: string;
  user: string;
  userName?: string;
  displayName?: string;
  text: string;
  attachments: Attachment[];
  isMessagingBot: boolean;
  threadTs?: string;
}

export interface ChannelStoreConfig {
  workingDir: string;
  botToken: string;
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
  conversationDir: string;
}) => Promise<boolean>;
