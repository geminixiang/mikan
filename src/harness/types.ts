import type { OfficeAddress, PlatformTrustModel } from "../types.js";
import type { MikanAgentSession } from "./session.js";
import type { Api, ImageContent, Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { ConversationResponder, MessagingInfo, SubagentProgressSnapshot } from "../types.js";
import type { resolveConversationSettings } from "../settings/index.js";
import type { Executor, RuntimePathContext, SandboxConfig } from "../sandbox/index.js";
import type { WorkspaceProjection } from "../office/types.js";
import type { Office } from "../office/index.js";
import type {
  AgentEvent,
  AgentHarnessTool,
  AgentTool,
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  ExecutionToolContext,
  ThinkingLevel,
  CompactionSettings,
  Skill,
} from "@earendil-works/pi-agent-core";
import type { MikanModels } from "./models.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { Static, TSchema } from "@sinclair/typebox";

export interface BuildSystemPromptOptions {
  workspacePath: string;
  office: Office;
  memory: string;
  sandboxConfig: SandboxConfig;
  platform: MessagingInfo;
  skills: MikanSkill[];
  projection: WorkspaceProjection;
  skippedSkillLinks?: string[];
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
  toolProgress: Map<string, { label: string; status: "running" | "done" | "error" }>;
  subagentProgress: Map<string, SubagentProgressSnapshot>;
  completedSubagentProgress: SubagentProgressSnapshot[];
  subagentToolCalls: Set<string>;
  subagentProgressShown: boolean;
  suppressResponseDeltas: boolean;
  lastSubagentProgressAt: number;
  toolProgressTimer: ReturnType<typeof setTimeout> | undefined;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  llmCallCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  toolInputCharacters: number;
  toolOutputCharacters: number;
  assistantMessageCount: number;
  outputCharacters: number;
  reasoningTokens: number;
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
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionConversation: string;
  sessionUuid: string;
  waitForQueue: () => Promise<void>;
}

export interface RunnerExecutionContext {
  executor: Executor;
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

export type { BranchSummaryEntry, CompactionEntry, CustomEntry };

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

export interface SubagentRunBudget {
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

export interface SubagentParentContext {
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
  modelsJsonPath?: string;
}

export interface MikanSkill extends Skill {
  baseDir: string;
  source: string;
  inline?: boolean;
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

export interface HarnessSettings {
  compaction: CompactionSettings;
  retry: RetrySettings;
  budget: BudgetSettings;
}

export interface SubagentProfileDiagnostic {
  type: "warning";
  message: string;
  path: string;
}

export interface LoadSubagentProfilesResult {
  profiles: Map<string, SubagentProfile>;
  diagnostics: SubagentProfileDiagnostic[];
}

export type CompactionReason = "threshold" | "overflow" | "manual";

interface CompactionResultSummary {
  summary: string;
  retainedMessages: number;
  tokensBefore: number;
}

export type HarnessEvent =
  | AgentEvent
  | { type: "compaction_start"; reason: CompactionReason }
  | {
      type: "compaction_end";
      reason: CompactionReason;
      result?: CompactionResultSummary;
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

export type MikanHarnessTool = AgentHarnessTool<ExecutionToolContext>;

export type MikanToolInput = AgentTool | MikanHarnessTool;

export interface MikanAgentSessionOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: MikanToolInput[];
  toolContext?: ExecutionToolContext;
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

export interface McpServerInstruction {
  server: string;
  text: string;
}

export interface McpToolsResult {
  tools: MikanHarnessTool[];
  errors: McpLoadError[];
  instructions: McpServerInstruction[];
  dispose: () => Promise<void>;
}
