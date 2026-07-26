/**
 * Core types for the mikan agent harness.
 *
 * The harness is built directly on pi-agent-core and pi-ai. Session entries
 * are structurally identical to pi-agent-core's `SessionTreeEntry`, and the
 * on-disk JSONL format stays compatible with the v3 session files mikan has
 * always written, so existing conversation history keeps working unchanged.
 */
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  CustomMessageEntry,
  MessageEntry,
  SessionContext,
  SessionInfoEntry,
  SessionTreeEntry,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
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
 * installation. Budget fields are caps — an explicit `request.budget` may
 * tighten them but never raise them.
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
  [extra: string]: unknown;
}

/** Raw file line: the header or one session entry. */
export type SessionFileEntry = SessionHeader | SessionEntry;
