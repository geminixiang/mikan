import type { Event } from "@sentry/node";

type SentryPrimitive = string | number | boolean;
type SentrySpanAttributeValue =
  | SentryPrimitive
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

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

export type SentryAttributionAttributes = Record<string, SentryPrimitive>;

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
