import type { Breadcrumb, ErrorEvent, Event, EventHint, Scope } from "@sentry/node";
import * as Sentry from "@sentry/node";

const REDACTED = "[REDACTED]";
const REDACTED_PATH = "[REDACTED_PATH]";
const MAX_STRING_LENGTH = 256;
const MAX_DEPTH = 4;

type SentryPrimitive = string | number | boolean;

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "args",
  "attachment",
  "attachments",
  "authorization",
  "body",
  "code",
  "content",
  "contents",
  "cookie",
  "cookies",
  "credential",
  "filepath",
  "headers",
  "image",
  "imageattachments",
  "images",
  "localpath",
  "messages",
  "newusermessage",
  "password",
  "path",
  "paths",
  "prompt",
  "refreshtoken",
  "response",
  "result",
  "secret",
  "systemprompt",
  "text",
  "thinking",
  "token",
  "url",
  "uri",
  "workspacepath",
]);

const ABSOLUTE_PATH_PATTERN =
  /(?:\/Users\/[^\s"'`]+|\/workspace\/[^\s"'`]+|\/tmp\/[^\s"'`]+|\/var\/folders\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/;
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];

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

export function createSentryInitOptions(dsn?: string) {
  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    enabled: Boolean(dsn) && process.env.SENTRY_ENABLED !== "false",
    sendDefaultPii: false,
    tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 1.0,
    includeLocalVariables: false,
    enableLogs: true,
    beforeSend(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
      return sanitizeEvent(event, hint);
    },
    beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
      return sanitizeBreadcrumb(breadcrumb);
    },
  };
}

export function reportUserFacingError(
  error: unknown,
  options: ReportUserFacingErrorOptions,
): string | undefined {
  if (options.expected) return undefined;

  const exception = error instanceof Error ? error : new Error(String(error));
  return Sentry.withScope((scope) => {
    scope.setLevel(options.severity ?? "error");
    scope.setTag("user_facing", "true");
    scope.setTag("expected", "false");
    scope.setTag("error_domain", options.domain);
    scope.setTag("error_surface", options.surface);
    scope.setTag("operation", options.operation);
    setOptionalTag(scope, "platform", options.platform);
    setOptionalTag(scope, "provider", options.provider);
    setOptionalTag(scope, "model", options.model);
    setOptionalTag(scope, "tool", options.toolName);
    setOptionalTag(scope, "stop_reason", options.stopReason);
    for (const [key, value] of Object.entries(options.tags ?? {})) {
      if (value !== undefined) scope.setTag(key, String(value));
    }
    if (options.fingerprint) scope.setFingerprint(options.fingerprint);
    scope.setContext("user_facing_error", {
      domain: options.domain,
      surface: options.surface,
      operation: options.operation,
      severity: options.severity ?? "error",
      platform: options.platform,
      provider: options.provider,
      model: options.model,
      toolName: options.toolName,
      stopReason: options.stopReason,
      ...(sanitizeValue(options.context ?? {}) as Record<string, unknown>),
    });
    return Sentry.captureException(exception);
  });
}

function setOptionalTag(scope: Scope, key: string, value: string | undefined): void {
  if (value !== undefined) scope.setTag(key, value);
}

export function applyRunScope(scope: Scope, context: SentryRunScopeContext): void {
  scope.setTag("conversation_id", context.conversationId);
  scope.setTag("channel_id", context.conversationId);
  scope.setTag("session_key", context.sessionKey);
  scope.setTag("platform", context.platform);
  if (context.threadTs) scope.setTag("thread_ts", context.threadTs);
  if (context.provider) scope.setTag("provider", context.provider);
  if (context.model) scope.setTag("model", context.model);

  scope.setUser({
    id: context.userId,
    username: context.userName,
  });
  scope.setContext("agent_run", {
    conversationId: context.conversationId,
    channelId: context.conversationId,
    sessionKey: context.sessionKey,
    messageId: context.messageId,
    threadTs: context.threadTs,
    platform: context.platform,
    provider: context.provider,
    model: context.model,
  });
}

export function metricAttributes(
  attributes: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string | number | boolean] => {
      const [, value] = entry;
      return value !== undefined;
    }),
  );
}

export function addLifecycleBreadcrumb(
  message: string,
  data?: Record<string, string | number | boolean | undefined>,
): void {
  Sentry.addBreadcrumb({
    category: "agent.lifecycle",
    message,
    level: "info",
    data: data ? metricAttributes(data) : undefined,
  });
}

export function sanitizeEvent<T extends Event>(event: T, _hint?: EventHint): T | null {
  const sanitized: T = {
    ...event,
    breadcrumbs: event.breadcrumbs
      ?.map((breadcrumb) => sanitizeBreadcrumb(breadcrumb))
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null),
    extra: sanitizeValue(event.extra) as T["extra"],
    contexts: sanitizeValue(event.contexts) as T["contexts"],
    request: sanitizeRequest(event.request),
    user: undefined,
    server_name: undefined,
  };

  if (sanitized.message) {
    sanitized.message = sanitizeString(sanitized.message);
  }

  if (sanitized.logentry) {
    sanitized.logentry = {
      ...sanitized.logentry,
      message: sanitized.logentry.message ? sanitizeString(sanitized.logentry.message) : undefined,
    };
  }

  if (sanitized.exception?.values) {
    sanitized.exception.values = sanitized.exception.values.map((value) => ({
      ...value,
      value: value.value ? sanitizeString(value.value) : value.value,
      stacktrace: value.stacktrace
        ? {
            ...value.stacktrace,
            frames: value.stacktrace.frames?.map((frame) => ({
              ...frame,
              filename: frame.filename ? sanitizeString(frame.filename) : frame.filename,
              abs_path: frame.abs_path ? sanitizeString(frame.abs_path) : frame.abs_path,
              vars: undefined,
            })),
          }
        : value.stacktrace,
    }));
  }

  return sanitized;
}

export function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") {
    return null;
  }

  return {
    ...breadcrumb,
    message: breadcrumb.message ? sanitizeString(breadcrumb.message) : breadcrumb.message,
    data: sanitizeValue(breadcrumb.data) as Breadcrumb["data"],
  };
}

export function sanitizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return "[Truncated]";

  if (isSensitiveKey(key)) {
    return summarizeValue(value, key);
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, key, depth + 1));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([entryKey, entryValue]) => [entryKey, sanitizeValue(entryValue, entryKey, depth + 1)],
    );
    return Object.fromEntries(entries);
  }

  return value;
}

function sanitizeRequest(request: Event["request"]): Event["request"] {
  if (!request) return request;

  return {
    ...request,
    data: request.data ? summarizeValue(request.data, "body") : undefined,
    headers: undefined,
    cookies: undefined,
  };
}

function isSensitiveKey(key?: string): boolean {
  if (!key) return false;
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function summarizeValue(value: unknown, key?: string): string {
  const label = key ?? "field";
  if (typeof value === "string") {
    return `[Redacted ${label}; length=${value.length}]`;
  }
  if (Array.isArray(value)) {
    return `[Redacted ${label}; items=${value.length}]`;
  }
  if (value && typeof value === "object") {
    return `[Redacted ${label}; keys=${Object.keys(value as Record<string, unknown>).length}]`;
  }
  return `[Redacted ${label}]`;
}

function sanitizeString(value: string): string {
  let sanitized = value.replace(new RegExp(ABSOLUTE_PATH_PATTERN, "g"), REDACTED_PATH);
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(pattern, "g"), REDACTED);
  }
  if (sanitized.length > MAX_STRING_LENGTH) {
    return `${sanitized.slice(0, MAX_STRING_LENGTH)}… [truncated ${sanitized.length - MAX_STRING_LENGTH} chars]`;
  }
  return sanitized;
}
