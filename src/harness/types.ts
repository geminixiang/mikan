import type { OfficeAddress, PlatformTrustModel } from "../types.js";
import type { MikanAgentSession } from "./session.js";
import type {
  Api,
  ImageContent,
  Message,
  Model,
  ModelThinkingLevel,
  RetryPolicy,
} from "@earendil-works/pi-ai";
import type { ConversationResponder, MessagingInfo } from "../types.js";
import type { resolveConversationSettings } from "../settings/index.js";
import type { RuntimePathContext, SandboxConfig } from "../sandbox/types.js";
import type { WorkspaceProjection, Office } from "../office/types.js";

import type { JsonValue } from "@earendil-works/chord";
import type { CompactionPolicy, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { TextContent } from "@earendil-works/pi-ai";
import type { MikanModels } from "./models.js";
import type { SessionStore } from "../sessions/session-store.js";

export interface EnsureDefaultOpenConnectorOptions {
  office: Office;
  platformWorkspaceId?: string;
  defaultServer?: McpServerConfig;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface ScratchListing {
  folders: string[];
  omitted: number;
}

export interface BuildSystemPromptOptions {
  workspacePath: string;
  office: Office;
  memory: string;
  sandboxConfig: SandboxConfig;
  platform: MessagingInfo;
  skills: MikanSkill[];
  projection: WorkspaceProjection;
  skippedSkillLinks?: string[];
  scratch: ScratchListing;
}

export interface RunnerSessionState {
  responder: ConversationResponder | null;
  logCtx: {
    conversationId: string;
    userName?: string;
    conversationName?: string;
    sessionId?: string;
  } | null;
  queue: {
    enqueue(fn: () => Promise<void>, errorContext: string): void;
  } | null;
  pendingTools: Map<string, { toolName: string; args: unknown; startTime: number }>;
  completedTools: ToolTiming[];
  toolProgress: Map<string, { label: string; status: "running" | "done" | "error" }>;
  answerStreamStarted: boolean;
  answerText: string;
  notice: string;
  workAcknowledged: boolean;
  publishRunEvent: RunEventListener | undefined;
  llmCallCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  toolInputCharacters: number;
  toolOutputCharacters: number;
  assistantMessageCount: number;
  outputCharacters: number;
  retryCount: number;
  compactionCount: number;
  budgetExceeded: boolean;
  firstTokenLatencyMs?: number;
  responseModel?: string;
  stopReason: string;
  errorMessage: string | undefined;
  reportedLlmError: boolean;
  finalResponseHandledByTool: boolean;
  triggerAttribution?: string;
}

export interface UsageReportContext {
  session: MikanAgentSession;
  runState: RunnerSessionState;
  responder: ConversationResponder;
  platform: MessagingInfo;
  model: Model<Api>;
  sessionConversation: string;
  sessionUuid: string;
  waitForQueue: () => Promise<void>;
}

export interface RunnerExecutionContext {
  env(): ExecutionEnv | undefined;
  sandboxConfig(): SandboxConfig;
  resolveForRun(context: {
    address: OfficeAddress;
    userId: string;
    trustModel?: PlatformTrustModel;
  }): Promise<{
    pathContext: RuntimePathContext;
    projection: WorkspaceProjection;
  }>;
}

export interface RunPresentation {
  wait(): Promise<void>;
  dispose(): void;
}

export interface RunPresentationContext {
  responder: ConversationResponder;
  sessionConversation: string;
  userName: string | undefined;
  sessionUuid: string;
  triggerAttribution: string | undefined;
  publishRunEvent?: RunEventListener;
}

export interface PlatformToolRoles {
  platformTools: ReadonlySet<string>;
  finalResponseTools: ReadonlySet<string>;
}

export interface SessionEventHandlerParams {
  session: MikanAgentSession;
  runState: RunnerSessionState;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  platformToolRoles: PlatformToolRoles;
}

export interface FinalizeRunResponseOptions {
  triggerSessionLink?: string;
  createOverflowLink?: () => string;
  platform?: string;
  model?: Model<Api>;
  sessionConversation?: string;
  sessionUuid?: string;
  initialTask?: boolean;
}

export interface PreparedRunContext {
  sessionConversation: string;
  userMessage: string;
  imageAttachments: ImageContent[];
  triggerAttribution?: string;
}

export interface CreateMikanModelsOptions {
  modelsJsonPath: string;
}

export interface MikanSkill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
  baseDir: string;
  source: string;
  inline?: boolean;
  directory?: string;
  enabled?: boolean;
}

export type SkillScope = "global" | "conversation";

export interface SkillPatterns {
  global: readonly string[];
  conversation: readonly string[];
}

export interface SkillDiagnostic {
  type: "warning";
  message: string;
  path: string;
  code?: "symlink";
}

export interface LoadSkillsResult {
  skills: MikanSkill[];
  diagnostics: SkillDiagnostic[];
}

export type RetrySettings = RetryPolicy;

export interface BudgetSettings {
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxLlmCalls?: number;
}

export type CompactionSettings = CompactionPolicy;

export interface HarnessSettings {
  compaction: CompactionSettings;
  retry: RetrySettings;
  budget: BudgetSettings;
}

type CompactionReason = "threshold" | "overflow" | "manual";

export type HarnessEvent =
  | { type: "message_start"; message: Message }
  | { type: "text_delta"; delta: string }
  | { type: "message_end"; message: Message }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; details: JsonValue }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: { content: (TextContent | ImageContent)[]; details?: unknown };
      isError: boolean;
      durationMs?: number;
    }
  | { type: "compaction_start"; reason: CompactionReason }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      aborted: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "budget_exceeded";
      reason: string;
      tokens: number;
      costUsd: number;
      llmCalls: number;
      durationMs: number;
    };

export type HarnessEventListener = (event: HarnessEvent) => void | Promise<void>;

export type RunEvent =
  | { type: "tool_started"; toolCallId: string; toolName: string; label: string }
  | {
      type: "tool_ended";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      resultText: string;
    }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_message"; thinking: string[]; text: string; callsTools: boolean }
  | { type: "compaction_started" }
  | { type: "retry_started"; attempt: number; maxAttempts: number }
  | { type: "budget_exceeded"; reason: string; llmCalls: number; durationMs: number }
  | { type: "run_started"; userName: string; text: string }
  | { type: "run_ended" };

export type RunEventListener = (event: RunEvent) => void;

export interface RunEventPublisher {
  publish(address: OfficeAddress, sessionKey: string, event: RunEvent): void;
}

export interface MikanToolContext {
  env(): ExecutionEnv | undefined;
}

export interface MikanAgentSessionOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  tools: ToolRegistration[];
  toolContext?: MikanToolContext;
  models: MikanModels;
  sessionStore: SessionStore;
  settings?: {
    compaction?: Partial<CompactionSettings>;
    retry?: Partial<RetrySettings>;
    budget?: Partial<BudgetSettings>;
  };
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  exposure?: McpExposure;
  description?: string;
}

export type McpExposure = "codemode" | "deferred";

export interface McpServerSummary {
  name: string;
  exposure: McpExposure;
  description?: string;
  instructions?: string;
}

type McpPresetCredentialTarget = "env" | "header" | "url";

interface McpPresetCredential {
  key: string;
  label: string;
  description: string;
  target: McpPresetCredentialTarget;
  required: boolean;
  secret: boolean;
  valuePrefix?: string;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  serverName: string;
  sourceUrl: string;
  setupUrl: string;
  server: McpServerConfig;
  credentials: McpPresetCredential[];
}

export interface McpLoadError {
  server: string;
  error: string;
}

export interface McpToolsResult {
  tools: ToolRegistration[];
  errors: McpLoadError[];
  servers: McpServerSummary[];
  dispose: () => Promise<void>;
}

export interface ToolTiming {
  label: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
}

export interface BudgetStopReport {
  reason: string;
  llmCalls: number;
  durationMs: number;
  completed: readonly ToolTiming[];
  running: readonly ToolTiming[];
}
