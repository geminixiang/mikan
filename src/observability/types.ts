type SentryPrimitive = string | number | boolean;

export interface SentryRunScopeContext {
  conversationId: string;
  sessionKey: string;
  messageId: string;
  platform: string;
  userId: string;
  userName?: string;
  threadTs?: string;
  provider?: string;
  model?: string;
}

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
