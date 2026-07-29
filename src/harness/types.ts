/**
 * Core types for the mikan agent harness.
 *
 * The harness is built directly on pi-agent-core and pi-ai. Session entries
 * are structurally identical to pi-agent-core's `SessionTreeEntry`, and the
 * on-disk JSONL format stays compatible with the v3 session files mikan has
 * always written, so existing conversation history keeps working unchanged.
 */
import type {
  AgentEvent,
  AgentTool,
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  MessageEntry,
  SessionContext,
  SessionInfoEntry,
  SessionTreeEntry,
  ThinkingLevel,
  CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionRegistry } from "./extensions/registry.js";
import type { MikanModels } from "./models.js";
import type { SessionStore } from "./session-store.js";
import type { Static, TSchema } from "@sinclair/typebox";

export type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  SessionContext,
  SessionInfoEntry,
};

/** Message entry as stored in mikan session files. */
export type SessionMessageEntry = MessageEntry;

/** Union of entry types mikan reads and writes. Alias of pi-agent-core's tree entry. */
export type SessionEntry = SessionTreeEntry;

export const CURRENT_SESSION_VERSION = 3;

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
  requiredTools: string[];
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
  /** Tool names that must each be invoked at least once before completion. */
  requiredTools?: string[];
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

/**
 * First line of every session file. `cwd` records where the session was
 * started; extra fields (for example mikan's `source` marker) are preserved
 * verbatim on read and rewrite.
 */
export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  parentSessionId?: string;
  [extra: string]: unknown;
}

/** Raw file line: the header or one session entry. */
export type SessionFileEntry = SessionHeader | SessionEntry;

export interface CreateMikanModelsOptions {
  authPath?: string;
  modelsJsonPath?: string;
}

export type EventConversationKind = "direct" | "shared";

export type EventType = "immediate" | "one-shot" | "periodic";

interface EventPayloadBase {
  /** Target platform; may be omitted when only one platform is running. */
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  /** Self-contained task text; event runs do not inherit conversation history. */
  text: string;
}

export interface ImmediateEventPayload extends EventPayloadBase {
  type: "immediate";
}

export interface OneShotEventPayload extends EventPayloadBase {
  type: "one-shot";
  /** ISO 8601 timestamp with offset. */
  at: string;
}

export interface PeriodicEventPayload extends EventPayloadBase {
  type: "periodic";
  /** Cron expression (croner syntax). */
  schedule: string;
  /** IANA timezone, e.g. "Asia/Taipei". */
  timezone: string;
}

/** Wire shape of one event file. */
export type EventFilePayload = ImmediateEventPayload | OneShotEventPayload | PeriodicEventPayload;

export interface EventPayloadInput {
  type: EventType;
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  text: string;
  at?: string;
  schedule?: string;
  timezone?: string;
}

/** A loaded skill. `baseDir` is the directory containing the skill file. */
export interface MikanSkill {
  name: string;
  description: string;
  /** Full skill instructions (file content without frontmatter). */
  content: string;
  filePath: string;
  baseDir: string;
  /** Where the skill was loaded from (e.g. "workspace", "channel"). */
  source: string;
  /** Exclude from model-visible skill lists. */
  disableModelInvocation?: boolean;
  /**
   * Embed the skill body in the prompt instead of referencing its file path.
   * Used for skills whose files the agent cannot read at runtime (e.g.
   * extension skills under the host-only state dir in sandbox modes).
   */
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

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export interface BudgetSettings {
  /** Max cumulative tokens processed this run (input + output + cache read/write). */
  maxTokens?: number;
  /** Max cumulative provider cost (USD) this run. Requires a populated model cost table. */
  maxCostUsd?: number;
  /** Max wall-clock duration for the run, in milliseconds. */
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
  firstKeptEntryId: string;
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

/** Outcome of a `prompt()` call that an extension blocked before the model ran. */
export interface PromptBlockedOutcome {
  blocked: true;
  reason?: string;
}

export interface MikanAgentSessionOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  models: MikanModels;
  sessionStore: SessionStore;
  settings?: {
    compaction?: Partial<CompactionSettings>;
    retry?: Partial<RetrySettings>;
    budget?: Partial<BudgetSettings>;
  };
  extensions?: ExtensionRegistry;
}
