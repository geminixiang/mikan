import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { RunEventPublisher, SubagentRunStatus } from "./harness/types.js";
import type { MikanModels } from "./harness/models.js";
import type { McpServerConfig } from "./harness/types.js";
import type { EventScheduleSink } from "./events/index.js";
import type { Office } from "./office/types.js";
import type { DockerContainerManager } from "./sandbox/provisioner.js";
import type { DockerExecFile, SandboxConfig } from "./sandbox/types.js";
import type { ChatHistorySync } from "./sessions/chat-history-sync.js";
import type { ResolvedSessionScope } from "./sessions/types.js";
import type { PlatformToolPackFactory } from "./harness/tools/types.js";
import type { VaultManager } from "./vault/types.js";

export type ConversationKind = "direct" | "shared";

export type PlatformName = "slack" | "discord" | "telegram" | "github";

export interface OfficeAddress {
  readonly platform: PlatformName;
  readonly conversationId: string;
}

export type OfficeKey = string & { readonly __brand: "OfficeKey" };

export interface OfficeRecord {
  readonly platform: PlatformName;
  readonly conversationId: string;
  readonly recordedAt: string;
}

export interface OfficeRegistryState {
  readonly version: 1;
  readonly offices: readonly OfficeRecord[];
}

export type PlatformTrustModel = "membership" | "open-trigger";

export interface ConversationMessage {
  id: string;
  address: OfficeAddress;
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

export type SubagentProgressStatus = SubagentRunStatus | "pending" | "running" | "skipped";

export interface SubagentProgressNode {
  id: string;
  label: string;
  status: SubagentProgressStatus;
  profile?: string;
  turns?: number;
  toolCalls?: number;
  toolCallCounts?: Record<string, number>;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  activity?: string;
  reason?: string;
  cleanupPending?: boolean;
}

export interface SubagentProgressSnapshot {
  mode: "single" | "parallel" | "dag";
  nodes: SubagentProgressNode[];
}

export interface TaskStatus {
  sessionKey: string;
  threadTs: string;
  acknowledgement: string;
  status:
    | "running"
    | "stopping"
    | "completed"
    | "aborted"
    | "failed"
    | "declined"
    | "queued"
    | "unknown";
  currentTool?: string;
  observedAt: string;
  endedAt?: string;
}

export interface ReplaceResponseOptions {
  createOverflowLink?: () => string;
  final?: boolean;
}

export interface ConversationResponder {
  startTask?(message: string, task: string): Promise<string>;
  notifyCompletion?(): Promise<void>;
  getTaskStatus?(sessionKey?: string): Promise<TaskStatus[]>;
  readonly showsPartialAnswer?: boolean;
  respond(text: string): Promise<void>;
  replaceResponse(text: string, options?: ReplaceResponseOptions): Promise<void>;
  replaceSubagentProgress?(
    progress: SubagentProgressSnapshot,
    finalText?: string,
    options?: ReplaceResponseOptions,
  ): Promise<void>;
  respondAsRole?(profile: string, text: string): Promise<void>;
  respondDiagnostic(text: string, options?: { style?: "muted" | "error" }): Promise<void>;
  respondToolResult(result: ChatToolResult): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  react?(emoji: string): Promise<void>;
  deleteResponse(): Promise<void>;
}

export interface MessagingInfo {
  name: string;
  workspaceId?: string;
  formattingGuide: string;
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
  trustModel?: PlatformTrustModel;
  diagnostics?: {
    showUsageSummary?: boolean;
  };
}

export interface ConversationEvent {
  type: string;
  address: OfficeAddress;
  vaultConversationId?: string;
  conversationKind: ConversationKind;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  attachments?: { name: string; localPath: string }[];
  sessionKey?: string;
}

export interface MessagingBot {
  start(): Promise<void>;
  stop(): Promise<void>;
  postMessage(channel: string, text: string): Promise<string>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  postInThread?(channel: string, threadTs: string, text: string): Promise<string>;
  logBotResponse?(
    channel: string,
    text: string,
    ts: string,
    threadTs?: string,
    extra?: { answer?: RunAnswer },
  ): void;
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

export interface ConversationContext {
  address: OfficeAddress;
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
}

export interface RunningSession {
  address: OfficeAddress;
  sessionKey: string;
  startedAt: number;
  lastActivityAt?: number;
  currentTool?: string;
  stopping?: boolean;
}

export interface HandleNewCommandOptions {
  bot: MessagingBot;
  message: ConversationMessage;
}

export interface MessagingEventHandler {
  isRunning(address: OfficeAddress, sessionKey: string): boolean;
  getRunningSessions(): RunningSession[];
  handleEvent(
    event: ConversationEvent,
    bot: MessagingBot,
    context: ConversationContext,
  ): Promise<void>;
  handleStop(
    address: OfficeAddress,
    sessionKey: string,
    bot: MessagingBot,
    replyThreadTs?: string,
  ): Promise<void>;
  steer?(message: ConversationMessage): Promise<boolean>;
  forceStop(address: OfficeAddress, sessionKey: string): void;
  handleNewCommand(options: HandleNewCommandOptions): Promise<void>;
}

export interface PiAgentWrapper {
  steer?(message: ConversationMessage): Promise<boolean>;
  syncChatHistory(currentMessageId?: string): Promise<void>;
  run(
    message: ConversationMessage,
    responder: ConversationResponder,
    platform: MessagingInfo,
  ): Promise<{ stopReason: string; errorMessage?: string; finalText?: string }>;
  abort(): void;
  getCurrentStep(): { toolName?: string; label?: string } | undefined;
  dispose(): Promise<void>;
}

export type WorkspaceVisibility = "public" | "private";

export interface SandboxSettings {
  cpus?: string;
  memory?: string;
  boost?: { cpus?: string; memory?: string };
  defaultSharedVault?: string;
}

export interface AgentConfig {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  sandbox?: SandboxSettings;
  slack?: {
    replyMode?: "top-level" | "thread";
  };
  mcpServers?: Record<string, McpServerConfig>;
}

export interface RunAnswer {
  replyTo: string;
  sessionKey: string;
}

export type LoggedAttachment = Attachment | { name: string; localPath: string };

export interface ConversationLogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  replyTo?: string;
  sessionKey?: string;
  user?: string;
  userName?: string;
  displayName?: string;
  text?: string;
  attachments?: LoggedAttachment[];
  isMessagingBot?: boolean;
  platform?: PlatformName;
  slackBlocks?: object[];
  slackInteraction?: Record<string, unknown>;
  botId?: string;
  appId?: string;
  subtype?: string;
}

export interface ActorContext {
  address: OfficeAddress;
  userId: string;
  trustModel?: PlatformTrustModel;
}

export interface LogContext {
  conversationId: string;
  userName?: string;
  conversationName?: string;
  sessionId?: string;
}

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

export interface ContainerMount {
  source: string;
  target: string;
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
  execFileImpl?: DockerExecFile;
}

export interface ExecutionPlan {
  credentialKey: string;
  resourceKey: string;
  sandboxConfig: SandboxConfig;
  env?: Record<string, string>;
  mounts: ContainerMount[];
}

export interface Attachment {
  original: string;
  localPath: string;
}

interface EnvVarSpec {
  name: string;
  required?: boolean;
  secret?: boolean;
  deploy?: boolean;
  doc: string;
}

export interface OnboardLlmChoice {
  provider: string;
  model: string;
}

export interface EnvGroup {
  key: string;
  title: string;
  kind: "platform" | "feature";
  vars: EnvVarSpec[];
  doc?: string;
  folded?: boolean;
}

export interface RunnerCacheControl {
  refreshConversation(address: OfficeAddress): boolean;
}

export interface GlobalRunnerCacheControl {
  refreshAllConversations(): { busy: OfficeAddress[] };
}

export type SettingsApplyResult = { ok: true; runtimeSwitched: boolean | null } | { ok: false };

export interface CreateRunnerOptions {
  sandboxConfig: SandboxConfig;
  sessionKey: string;
  office: Office;
  trustModel: PlatformTrustModel;
  platformWorkspaceId?: string;
  openConnector?: McpServerConfig;
  eventScheduler?: EventScheduleSink;
  sessionScope: ResolvedSessionScope;
  chatHistory: ChatHistorySync;
  signal?: AbortSignal;
  vaultManager?: VaultManager;
  provisioner?: DockerContainerManager;
  resourceController?: SandboxResourceController;
  sessionView?: {
    tokenStore: SessionViewTokenStoreLike;
    portalBaseUrl?: string;
  };
  platformToolPackFactories?: readonly PlatformToolPackFactory[];
  models: MikanModels;
  runEvents?: RunEventPublisher;
}

export interface SessionViewTokenCreateOptions {
  platform: PlatformName;
  platformUserId: string;
  conversationId: string;
  sessionKey: string;
  office: Office;
  platformUserName?: string;
}

export interface SessionViewTokenStoreLike {
  create(options: SessionViewTokenCreateOptions): { token: string };
}
