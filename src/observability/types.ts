type SentryPrimitive = string | number | boolean;

export interface RunScopeContext {
  conversationId: string;
  sessionKey: string;
  messageId: string;
  platform: string;
  conversationKind?: "direct" | "shared";
  userId: string;
  threadTs?: string;
  provider?: string;
  model?: string;
}

export type ObservabilityAttributes = Record<string, SentryPrimitive>;

export type SentryAttributionAttributes = ObservabilityAttributes;

export type SentryRunScopeContext = RunScopeContext;

type UserFacingErrorDomain =
  | "llm"
  | "chat_platform"
  | "mikan"
  | "sandbox"
  | "login"
  | "events"
  | "session_view";

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

export type JevCaller =
  | "jev_tool"
  | "jev_browser"
  | "slack_auto_reply"
  | "task_intent"
  | "memory_capture";

export interface JevOutcomeReport {
  caller: JevCaller;
  status: "ok" | "error";
  errorType?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}
