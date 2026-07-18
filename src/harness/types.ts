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
} from "@earendil-works/pi-agent-core";
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

export interface SubagentUsage {
  tokens: number;
  costUsd: number;
}

/** A fresh, isolated subagent run. */
export interface SubagentRunRequest<TOutputSchema extends TSchema | undefined = undefined> {
  task: string;
  /** Opt in to a normalized textual snapshot of the active parent run. Defaults to fresh. */
  parentContext?: SubagentParentContext;
  systemPrompt?: string;
  /** JSON-serializable input appended to the task. */
  input?: unknown;
  /** Defaults to the parent runner's configured model. */
  model?: SubagentModelSpec;
  /** Tool names explicitly granted to the subagent. Defaults to no tools. */
  tools?: string[];
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
  tokens: number;
  costUsd: number;
  durationMs: number;
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
