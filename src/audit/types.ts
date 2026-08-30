import type { OfficeAddress } from "../types.js";

type AgentAuditRunKind = "interactive" | "event" | "session_dream" | "subagent";

export type AgentAuditStatus =
  | "admitted"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "blocked"
  | "cancelled"
  | "timeout"
  | "budget_exceeded"
  | "invalid_output";

type AgentAuditEventType =
  | "run_admitted"
  | "run_started"
  | "run_setup_failed"
  | "run_completed"
  | "run_failed"
  | "run_aborted"
  | "turn_started"
  | "turn_completed"
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_request_aborted"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "tool_blocked"
  | "retry_started"
  | "retry_completed"
  | "compaction_started"
  | "compaction_completed"
  | "compaction_failed"
  | "budget_exceeded"
  | "subagent_spawned"
  | "subagent_completed";

export interface AgentAuditEventDetails {
  purpose?: "agent" | "compaction";
  origin?: "interactive" | "event" | "session_dream";
  sourceEventType?: string;
  compactionReason?: "threshold" | "overflow" | "manual";
  responseModel?: string;
  messageCount?: number;
  toolCount?: number;
  toolResultCount?: number;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  retainedMessages?: number;
  tokensBefore?: number;
  attachmentCount?: number;
  imageAttachmentCount?: number;
  success?: boolean;
  aborted?: boolean;
  budgetExceeded?: boolean;
}

export interface AgentAuditUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

export interface AgentAuditRunIdentity {
  officeKey: string;
  address: OfficeAddress;
  sessionKey: string;
  runKind: AgentAuditRunKind;
  runId?: string;
  parentRunId?: string;
  parentToolCallId?: string;
}

export interface AgentAuditChildRunOptions {
  runKind: AgentAuditRunKind;
  runId?: string;
  parentToolCallId?: string;
}

export interface AgentAuditEventInput {
  type: AgentAuditEventType;
  occurredAtMs?: number;
  status?: AgentAuditStatus;
  sessionId?: string;
  turnId?: string;
  modelRequestId?: string;
  toolCallId?: string;
  relatedRunId?: string;
  toolName?: string;
  modelProvider?: string;
  modelId?: string;
  responseId?: string;
  stopReason?: string;
  errorType?: string;
  durationMs?: number;
  llmCalls?: number;
  toolCalls?: number;
  usage?: AgentAuditUsage;
  details?: AgentAuditEventDetails;
}

export interface AgentAuditEventEnvelope extends AgentAuditEventInput {
  eventId: string;
  schemaVersion: 1;
  ingestedAtMs: number;
  occurredAtMs: number;
  runSequence: number;
  runId: string;
  runKind: AgentAuditRunKind;
  officeKey: string;
  platform: string;
  conversationId: string;
  sessionKey: string;
  parentRunId?: string;
  parentToolCallId?: string;
  expiresAtMs: number;
}

export interface AgentAuditRun {
  readonly runId: string;
  readonly runKind: AgentAuditRunKind;
  readonly parentRunId?: string;
  record(event: AgentAuditEventInput): void;
  child(options: AgentAuditChildRunOptions): AgentAuditRun;
}

export interface AgentAuditRunQuery {
  officeKey?: string;
  platform?: string;
  conversationId?: string;
  runId?: string;
  toolName?: string;
  status?: AgentAuditStatus;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  cursor?: string;
}

export interface AgentAuditRunSummary {
  runId: string;
  runKind: AgentAuditRunKind;
  officeKey: string;
  platform: string;
  conversationId: string;
  sessionKey: string;
  sessionId: string | null;
  parentRunId: string | null;
  parentToolCallId: string | null;
  status: AgentAuditStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  modelProvider: string | null;
  modelId: string | null;
  stopReason: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
  lastEventAtMs: number;
}

export interface AgentAuditRunPage {
  runs: AgentAuditRunSummary[];
  nextCursor?: string;
}

export interface AgentAuditEventRecord {
  eventId: string;
  occurredAtMs: number;
  ingestedAtMs: number;
  runSequence: number;
  runId: string;
  eventType: AgentAuditEventType;
  status: AgentAuditStatus | null;
  sessionId: string | null;
  turnId: string | null;
  modelRequestId: string | null;
  toolCallId: string | null;
  relatedRunId: string | null;
  toolName: string | null;
  modelProvider: string | null;
  modelId: string | null;
  responseId: string | null;
  stopReason: string | null;
  errorType: string | null;
  durationMs: number | null;
  llmCalls: number | null;
  toolCalls: number | null;
  usage: AgentAuditUsage | null;
  details: AgentAuditEventDetails;
}

export interface AgentAuditToolCallSummary {
  runId: string;
  toolCallId: string;
  turnId: string | null;
  toolName: string;
  status: AgentAuditStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
}

export interface AgentAuditModelRequestSummary {
  runId: string;
  modelRequestId: string;
  turnId: string | null;
  modelProvider: string;
  modelId: string;
  responseId: string | null;
  status: AgentAuditStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  stopReason: string | null;
  usage: AgentAuditUsage;
}

export interface AgentAuditRunDetailQuery {
  /** Fetch events older than this run sequence. Omit for the newest page. */
  beforeSequence?: number;
  eventLimit?: number;
}

export interface AgentAuditRunDetail {
  run: AgentAuditRunSummary;
  events: AgentAuditEventRecord[];
  nextBeforeSequence?: number;
  tools: AgentAuditToolCallSummary[];
  modelRequests: AgentAuditModelRequestSummary[];
  childRuns: AgentAuditRunSummary[];
  relatedTruncated: boolean;
}

export interface AgentAuditHealth {
  enabled: boolean;
  available: boolean;
  degraded: boolean;
  dbPath: string;
  retentionDays: number;
  queueDepth: number;
  queueBytes: number;
  inFlightEvents: number;
  droppedEvents: number;
  producerErrors: number;
  writeFailures: number;
  lastWriteAtMs: number | null;
  lastRetentionAtMs: number | null;
  lastError: string | null;
  databaseBytes: number;
  eventCount: number;
  runCount: number;
}

export interface AgentAuditService {
  startRun(identity: AgentAuditRunIdentity): AgentAuditRun;
  listRuns(query?: AgentAuditRunQuery): Promise<AgentAuditRunPage>;
  getRun(runId: string, query?: AgentAuditRunDetailQuery): Promise<AgentAuditRunDetail | null>;
  getHealth(): Promise<AgentAuditHealth>;
  flush(): Promise<void>;
  runRetention(): Promise<number>;
  close(timeoutMs?: number): Promise<void>;
}

export interface AgentAuditStoreOptions {
  stateDir: string;
  retentionDays?: number;
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  batchSize?: number;
  retentionIntervalMs?: number;
}

export interface AuditWorkerInitData {
  dbPath: string;
  retentionMs: number;
}

export type AuditWorkerRequest =
  | { type: "append"; batchId: number; events: AgentAuditEventEnvelope[] }
  | { type: "list_runs"; requestId: number; query: AgentAuditRunQuery }
  | {
      type: "get_run";
      requestId: number;
      runId: string;
      query: AgentAuditRunDetailQuery;
    }
  | { type: "health"; requestId: number }
  | { type: "retention"; requestId: number; nowMs: number }
  | { type: "close"; requestId: number };

export type AuditWorkerResponse =
  | { type: "ready" }
  | { type: "append_result"; batchId: number; written: number; error?: string }
  | { type: "list_runs_result"; requestId: number; result?: AgentAuditRunPage; error?: string }
  | {
      type: "get_run_result";
      requestId: number;
      result?: AgentAuditRunDetail | null;
      error?: string;
    }
  | { type: "health_result"; requestId: number; result?: AuditWorkerHealth; error?: string }
  | {
      type: "retention_result";
      requestId: number;
      deleted?: number;
      more?: boolean;
      error?: string;
    }
  | { type: "close_result"; requestId: number; error?: string }
  | { type: "fatal"; error: string };

export interface AuditWorkerHealth {
  databaseBytes: number;
  eventCount: number;
  runCount: number;
}
