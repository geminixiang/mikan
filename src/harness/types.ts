import type { OfficeAddress, PlatformTrustModel } from "../types.js";
import type { MikanAgentSession } from "./session.js";
import type { Api, ImageContent, Model, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import type { ConversationResponder, MessagingInfo, SubagentProgressSnapshot } from "../adapter.js";
import type { resolveConversationSettings } from "../config.js";
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

/**
 * A curated capability set a subagent can be launched with. Built-ins ship
 * with the harness; `<workspaceDir>/agents/<name>.md` patches them per
 * installation. Turn, cost, and duration fields are caps — an explicit
 * `request.budget` may tighten them but never raise them. Token budgets use the
 * larger of the profile default and the request value.
 */
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
  /** Maximum assistant/model calls in the subagent run. */
  maxTurns?: number;
  /** Maximum cumulative input/output/cache tokens. */
  maxTokens?: number;
  /** Maximum provider cost in USD. */
  maxCostUsd?: number;
  /** Maximum wall-clock duration. */
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
  /** Number of recent user/assistant turns to include. Defaults to 3. */
  recentTurns?: number;
}

/** Aggregated model usage across every assistant turn in a subagent run. */
export type SubagentUsage = Usage;

/** Receives usage from a subagent run, including after detached cleanup settles. */
export type SubagentUsageSink = (usage: SubagentUsage) => void | Promise<void>;

/** A fresh, isolated subagent run. */
export interface SubagentRunRequest<TOutputSchema extends TSchema | undefined = undefined> {
  task: string;
  /** Named profile: a harness built-in, patched by `<workspaceDir>/agents/<name>.md`. */
  profile?: string;
  /** Opt in to a normalized textual snapshot of the active parent run. Defaults to fresh. */
  parentContext?: SubagentParentContext;
  systemPrompt?: string;
  /** JSON-serializable input appended to the task. */
  input?: unknown;
  /** Defaults to the parent runner's configured model. */
  model?: SubagentModelSpec;
  /** Tool names explicitly granted to the subagent. Defaults to no tools. */
  tools?: string[];
  /** Per-profile thinking override. */
  thinkingLevel?: ThinkingLevel;
  /** When present, the final response must be JSON matching this schema. */
  outputSchema?: TOutputSchema;
  budget?: SubagentRunBudget;
  signal?: AbortSignal;
}

export type SubagentRunOutput<TSchemaOrUndefined extends TSchema | undefined> =
  TSchemaOrUndefined extends TSchema ? Static<TSchemaOrUndefined> : string;

interface SubagentRunMetadata {
  runId: string;
  /** Raw final assistant text, including when structured validation failed. */
  text?: string;
  model: SubagentModelSpec;
  turns: number;
  toolCalls: number;
  toolCallCounts: Record<string, number>;
  /** Full token and cost breakdown across the run. */
  usage: SubagentUsage;
  /** Aggregate token count; equivalent to `usage.totalTokens`. */
  tokens: number;
  /** Aggregate provider cost; equivalent to `usage.cost.total`. */
  costUsd: number;
  durationMs: number;
  /**
   * The caller received a terminal result before the underlying run settled.
   * When true, `usage`, `tokens`, and `costUsd` are provisional snapshots;
   * final usage is delivered later through the run's bound usage sink. The
   * global slot remains held until cleanup settles because in-process work
   * cannot be safely reclaimed without a killable execution boundary.
   */
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

/**
 * A loaded skill: Pi's native `Skill` shape plus mikan provenance.
 * `baseDir` is the directory containing the skill file.
 */
export interface MikanSkill extends Skill {
  baseDir: string;
  /** Where the skill was loaded from (e.g. "workspace", "channel"). */
  source: string;
  /** Embed the skill body in the prompt instead of referencing its file path. */
  inline?: boolean;
}

export interface SkillDiagnostic {
  type: "warning";
  message: string;
  path: string;
  /** Set when the entry was skipped because it is a symlink on a rejecting load. */
  code?: "symlink";
}

export interface LoadSkillsResult {
  skills: MikanSkill[];
  diagnostics: SkillDiagnostic[];
}

export type RetrySettings = RetryPolicy;

export interface BudgetSettings {
  /** Max cumulative tokens processed this run (input + output + cache read/write). */
  maxTokens?: number;
  /** Max cumulative provider cost (USD) this run. Requires a populated model cost table. */
  maxCostUsd?: number;
  /** Wall-clock deadline in milliseconds; signals cancellation and waits for active cleanup. */
  maxDurationMs?: number;
  /** Max number of LLM calls (assistant turns) this run. */
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
  /** Number of recent messages retained inline on the compaction entry. */
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
      /** Which cap was hit, e.g. "cost 2.01 USD > 2 USD limit". */
      reason: string;
      tokens: number;
      costUsd: number;
      llmCalls: number;
      durationMs: number;
    };

export type HarnessEventListener = (event: HarnessEvent) => void | Promise<void>;

/**
 * A tool as the harness sees it: pi-native tools (read/write/edit/bash) and
 * mikan tools adapted at the tool-list boundary. The context carries the
 * sandbox-backed execution env.
 */
export type MikanHarnessTool = AgentHarnessTool<ExecutionToolContext>;

/**
 * A session tool entry: a harness tool (pi-native or adapted), or a plain
 * mikan `AgentTool` that the session upgrades at the boundary. The union keeps
 * the published `MikanAgentSession` API accepting the legacy `AgentTool` shape.
 */
export type MikanToolInput = AgentTool | MikanHarnessTool;

export interface MikanAgentSessionOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: MikanToolInput[];
  /** Required by native execution tools; plain AgentTools need no execution env. */
  toolContext?: ExecutionToolContext;
  models: MikanModels;
  sessionStore: SessionStore;
  settings?: {
    compaction?: Partial<CompactionSettings>;
    retry?: Partial<RetrySettings>;
    budget?: Partial<BudgetSettings>;
  };
}

/**
 * MCP (Model Context Protocol) server configuration and load results.
 *
 * A server entry is either stdio (`command` + optional `args`/`env`) or
 * streamable HTTP (`url` + optional `headers`). Exactly one of `command`
 * or `url` must be set — the settings schema keeps both optional so the
 * file stays object-rooted and forgiving; `loadMcpTools` enforces the
 * exclusivity at runtime.
 *
 * Credentials (API keys in `env`/`headers`) stay in host-side settings and
 * the MCP server process; the model sees only tool names and schemas.
 */
export interface McpServerConfig {
  /** stdio transport: executable to spawn on the host. */
  command?: string;
  args?: string[];
  /** Extra environment for the spawned server, merged over a safe default. */
  env?: Record<string, string>;
  /** streamable-HTTP transport: server endpoint URL. */
  url?: string;
  headers?: Record<string, string>;
  /** Disable without deleting — lets a conversation turn off a global server. */
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
  /** Tools namespaced `mcp__<server>__<tool>`, ready for the agent tool list. */
  tools: AgentTool<TSchema>[];
  errors: McpLoadError[];
  /** Admin-approved server guidance for operating its tools. */
  instructions: McpServerInstruction[];
  /** Close all server connections (and kill stdio child processes). */
  dispose: () => Promise<void>;
}
