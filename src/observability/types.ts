import type { Event } from "@sentry/node";

type SentryPrimitive = string | number | boolean;
type SentrySpanAttributeValue =
  | SentryPrimitive
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

export interface RunScopeContext {
  conversationId: string;
  sessionKey: string;
  messageId: string;
  platform: string;
  conversationKind?: "direct" | "shared";
  userId: string;
  userName?: string;
  threadTs?: string;
  provider?: string;
  model?: string;
}

export type ObservabilityAttributes = Record<string, SentryPrimitive>;

/** @internal Sentry adapter alias; application code uses ObservabilityAttributes. */
export type SentryAttributionAttributes = ObservabilityAttributes;

/** @internal Sentry adapter alias; application code uses RunScopeContext. */
export type SentryRunScopeContext = RunScopeContext;

export interface SentrySpanPayload {
  trace_id: string;
  span_id: string;
  start_timestamp: number;
  data: Record<string, SentrySpanAttributeValue | undefined>;
}

export interface SentryTransactionPayload extends Event {
  type: "transaction";
  entries?: Array<{ type?: string; data?: unknown }>;
}

type UserFacingErrorDomain =
  | "llm"
  | "chat_platform"
  | "mikan"
  | "sandbox"
  | "login"
  | "events"
  | "session_view"
  | "subagent";

type UserFacingErrorSeverity = "warning" | "error" | "fatal";

export interface ReportUserFacingErrorOptions {
  domain: UserFacingErrorDomain;
  surface: string;
  operation: string;
  severity?: UserFacingErrorSeverity;
  platform?: string;
  provider?: string;
  model?: string;
  toolName?: string;
  stopReason?: string;
  expected?: boolean;
  fingerprint?: string[];
  tags?: Record<string, SentryPrimitive | undefined>;
  context?: Record<string, unknown>;
}

/** Terminal states of one subagent run as seen by the parent tool. */
export type SubagentOutcomeStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout"
  | "budget_exceeded"
  | "invalid_output"
  | "skipped";

/** Metrics-only view of a subagent outcome; never carries task text or labels. */
export interface SubagentOutcomeReport {
  itemId: string;
  mode: "single" | "parallel" | "dag";
  status: SubagentOutcomeStatus;
  profile?: string;
  error?: string;
  turns?: number;
  toolCalls?: number;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  cleanupPending?: boolean;
}
