import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

// ── adapter ───────────────────────────────────────────────────────────────────

export type ConversationKind = "direct" | "shared";

export type PlatformName = "slack" | "discord" | "telegram";

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

export interface ChatResponseBlockKit {
  text: string;
  blocks: object[];
}

export interface ConversationResponder {
  respond(text: string): Promise<void>;
  appendResponseDelta?(delta: string): Promise<void>;
  finishResponse?(finalText?: string): Promise<void>;
  replaceResponse(text: string, options?: { createOverflowLink?: () => string }): Promise<void>;
  respondDiagnostic(text: string, options?: { style?: "muted" | "error" }): Promise<void>;
  respondToolResult(result: ChatToolResult): Promise<void>;
  respondBlockKit?(response: ChatResponseBlockKit): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  deleteResponse(): Promise<void>;
}

export interface MessagingInfo {
  name: string;
  formattingGuide: string;
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
  diagnostics?: {
    showUsageSummary?: boolean;
  };
}

export interface ChatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getMessagingInfo(): MessagingInfo;
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
}

// ── config ────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  sentryDsn?: string;
  sandboxCpus?: string;
  sandboxMemory?: string;
  sandboxBoostCpus?: string;
  sandboxBoostMemory?: string;
  sandboxImageWorkspaceMount?: "private" | "full";
  defaultSharedVault?: string;
  slack?: {
    replyMode?: "top-level" | "thread";
  };
}

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

export interface ImmediateEvent {
  type: "immediate";
  platform: string;
  conversationId: string;
  conversationKind: ConversationKind;
  userId?: string;
  text: string;
}

export interface OneShotEvent {
  type: "one-shot";
  platform: string;
  conversationId: string;
  conversationKind: ConversationKind;
  userId?: string;
  text: string;
  at: string;
}

export interface PeriodicEvent {
  type: "periodic";
  platform: string;
  conversationId: string;
  conversationKind: ConversationKind;
  userId?: string;
  text: string;
  schedule: string;
  timezone: string;
}

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
}

export type ImageWorkspaceMountMode = "private" | "full";

// ── log ───────────────────────────────────────────────────────────────────────

export interface LogContext {
  conversationId: string;
  userName?: string;
  conversationName?: string;
  sessionId?: string;
}

// ── portal-shell ──────────────────────────────────────────────────────────────

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

export type AutoReplyJudge = (input: {
  event: ConversationEvent;
  rules: string[];
  conversationDir: string;
}) => Promise<boolean>;
