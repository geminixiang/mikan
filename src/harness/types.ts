import type { OfficeAddress, PlatformTrustModel } from "../types.js";
import type { MikanAgentSession } from "./session.js";
import type { Api, ImageContent, Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { ConversationResponder, MessagingInfo, SubagentProgressSnapshot } from "../types.js";
import type { resolveConversationSettings } from "../settings/index.js";
import type { RuntimePathContext, SandboxConfig } from "../sandbox/types.js";
import type { WorkspaceProjection, Office } from "../office/types.js";

import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  CompactionPolicy,
  ToolControl,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { JsonValue as ModelJsonValue, TextContent } from "@earendil-works/pi-ai";
import type { MikanModels } from "./models.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { Static, TSchema } from "typebox";

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
  subagentProgress: Map<string, SubagentProgressSnapshot>;
  completedSubagentProgress: SubagentProgressSnapshot[];
  subagentToolCalls: Set<string>;
  subagentProgressShown: boolean;
  suppressResponseDeltas: boolean;
  answerStreamStarted: boolean;
  answerText: string;
  notice: string;
  workAcknowledged: boolean;
  publishRunEvent: RunEventListener | undefined;
  lastSubagentProgressAt: number;
  toolProgressTimer: ReturnType<typeof setTimeout> | undefined;
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

export interface SubagentModelSpec {
  provider: string;
  id: string;
}

export interface SubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: SubagentModelSpec;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

interface SubagentRunBudget {
  maxTurns?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
}

export type SubagentRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "budget_exceeded"
  | "invalid_output";

interface SubagentParentContext {
  mode: "normalized";
  recentTurns?: number;
}

export type SubagentUsage = Usage;

export type SubagentUsageSink = (usage: SubagentUsage) => void | Promise<void>;

export interface SubagentRunRequest<TOutputSchema extends TSchema | undefined = undefined> {
  task: string;
  profile?: string;
  parentContext?: SubagentParentContext;
  systemPrompt?: string;
  input?: unknown;
  model?: SubagentModelSpec;
  tools?: string[];
  thinkingLevel?: ThinkingLevel;
  outputSchema?: TOutputSchema;
  budget?: SubagentRunBudget;
  signal?: AbortSignal;
}

export type SubagentRunOutput<TSchemaOrUndefined extends TSchema | undefined> =
  TSchemaOrUndefined extends TSchema ? Static<TSchemaOrUndefined> : string;

interface SubagentRunMetadata {
  runId: string;
  text?: string;
  model: SubagentModelSpec;
  turns: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  usage: SubagentUsage;
  tokens: number;
  costUsd: number;
  durationMs: number;
  cleanupPending?: boolean;
}

interface SubagentRunCompletedResult<TOutput> extends SubagentRunMetadata {
  status: "completed";
  output: TOutput;
  error?: never;
}

interface SubagentRunIncompleteResult extends SubagentRunMetadata {
  status: Exclude<SubagentRunStatus, "completed">;
  output?: never;
  error?: string;
}

export type SubagentRunResult<TOutput = string> =
  | SubagentRunCompletedResult<TOutput>
  | SubagentRunIncompleteResult;

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

export type ToolLoopVerdict =
  | { kind: "allow" }
  | { kind: "notice"; text: string }
  | { kind: "block"; reason: string }
  | { kind: "stop"; reason: string };

export interface SubagentProfileDiagnostic {
  type: "warning";
  message: string;
  path: string;
}

export interface LoadSubagentProfilesResult {
  profiles: Map<string, SubagentProfile>;
  diagnostics: SubagentProfileDiagnostic[];
}

type CompactionReason = "threshold" | "overflow" | "manual";

export type HarnessEvent =
  | { type: "message_start"; message: AgentMessage }
  | { type: "text_delta"; delta: string }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; details: JsonValue }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: { content: (TextContent | ImageContent)[]; details?: unknown };
      isError: boolean;
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
  | { type: "subagent_progress"; toolCallId: string; snapshot: SubagentProgressSnapshot }
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

export interface MikanToolResult {
  content?: (TextContent | ImageContent)[];
  details?: JsonValue;
  isError?: boolean;
  structuredContent?: ModelJsonValue;
  usage?: Usage;
  control?: ToolControl;
}

export type MikanHarnessTool = Omit<ToolRegistration, "execute"> & {
  outputSchema?: TSchema;
  exposure?: McpExposure;
  namespace?: string;
  execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<MikanToolResult>;
};

export interface ToolSearchOptions {
  tools: readonly MikanHarnessTool[];
  query: string;
  limit?: number;
  namespace?: string;
}

export interface ToolSearchToolOptions {
  tools: readonly MikanHarnessTool[];
  loaded: ReadonlySet<string>;
  load: (names: string[], context: Context) => Promise<void>;
}

export interface CodemodeToolOptions {
  tools: readonly MikanHarnessTool[];
  servers?: readonly McpServerSummary[];
  executeNested: (
    tool: MikanHarnessTool,
    args: Parameters<MikanHarnessTool["execute"]>,
  ) => Promise<MikanToolResult>;
}

export type MikanToolInput = AgentTool | MikanHarnessTool;

export interface MikanAgentSessionOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: MikanToolInput[];
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
  tools: MikanHarnessTool[];
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
