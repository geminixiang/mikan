import type { Breadcrumb, Event, EventHint, Scope } from "@sentry/node";
import * as Sentry from "@sentry/node";
import { readEnv } from "../env-manifest.js";

const REDACTED = "[REDACTED]";
const REDACTED_PATH = "[REDACTED_PATH]";
const MAX_STRING_LENGTH = 256;
const MAX_DEPTH = 4;
const TRACE_ATTRIBUTION_TTL_MS = 5 * 60 * 1000;

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "apitoken",
  "args",
  "attachment",
  "attachments",
  "authorization",
  "body",
  "clientsecret",
  "code",
  "completion",
  "completions",
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
  "toolarguments",
  "toolargs",
  "toolinput",
  "tooloutput",
  "token",
  "url",
  "uri",
  "workspacepath",
]);

const ABSOLUTE_PATH_PATTERN = /(?:(?<![A-Za-z0-9:/])\/(?!\/)[^\s"'`<>]+|[A-Za-z]:\\[^\s"'`<>]+)/;
const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];

export type {
  ReportUserFacingErrorOptions,
  SentryAttributionAttributes,
  SentryRunScopeContext,
  SentrySpanPayload,
} from "./types.js";
import type {
  ReportUserFacingErrorOptions,
  SentryAttributionAttributes,
  SentryRunScopeContext,
  SentrySpanPayload,
  SentryTransactionPayload,
} from "./types.js";

interface TraceAttributionEntry {
  attributes: SentryAttributionAttributes;
  expiresAt: number;
}

const traceAttribution = new Map<string, TraceAttributionEntry>();

export function createSentryInitOptions(dsn?: string, customOpenTelemetry = false) {
  return {
    dsn,
    environment: readEnv("SENTRY_ENVIRONMENT") ?? "production",
    enabled: Boolean(dsn) && readEnv("SENTRY_ENABLED") !== "false",
    sendDefaultPii: false,
    tracesSampleRate: customOpenTelemetry ? undefined : 1.0,
    skipOpenTelemetrySetup: customOpenTelemetry,
    registerEsmLoaderHooks: customOpenTelemetry ? false : undefined,
    includeLocalVariables: false,
    enableLogs: true,
    integrations(defaultIntegrations: ReturnType<typeof Sentry.getDefaultIntegrations>) {
      const retained = defaultIntegrations.filter(
        (integration) =>
          integration.name !== "OpenAI" &&
          (!customOpenTelemetry ||
            (integration.name !== "Http" && integration.name !== "NodeFetch")),
      );
      if (!customOpenTelemetry) return retained;

      return [
        ...retained,
        Sentry.httpIntegration({ spans: false, tracePropagation: false }),
        Sentry.nativeNodeFetchIntegration({ tracePropagation: false }),
      ];
    },
    beforeSend: sanitizeEvent,
    beforeSendSpan: applySpanAttribution,
    beforeSendTransaction: sanitizeTransactionEvent,
    beforeBreadcrumb: sanitizeBreadcrumb,
  };
}

export function captureSentryError(
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

export function closeSentry(timeoutMs: number): Promise<boolean> {
  return Sentry.close(timeoutMs);
}

export function recordSentryCounter(
  name: string,
  value: number,
  attributes: SentryAttributionAttributes,
): void {
  Sentry.metrics.count(name, value, { attributes });
}

export function recordSentryDistribution(
  name: string,
  value: number,
  options: { unit?: string; attributes: SentryAttributionAttributes },
): void {
  Sentry.metrics.distribution(name, value, options);
}

export function recordSentryGauge(
  name: string,
  value: number,
  options: { unit?: string; attributes: SentryAttributionAttributes },
): void {
  Sentry.metrics.gauge(name, value, options);
}

export function addSentryBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
  options: {
    category?: string;
    level?: "info" | "warning";
    log?: boolean;
  } = {},
): void {
  if (options.log) Sentry.logger.info(message, data);
  Sentry.addBreadcrumb({
    category: options.category ?? "agent.lifecycle",
    message,
    level: options.level ?? "info",
    data,
  });
}

export function withSentryRunScope<T>(context: SentryRunScopeContext, body: () => T): T {
  return Sentry.withScope((scope) => {
    applyRunScope(scope, context);
    return body();
  });
}

function setOptionalTag(scope: Scope, key: string, value: string | undefined): void {
  if (value !== undefined) scope.setTag(key, value);
}

export function createRunScopeAttributes(
  context: SentryRunScopeContext,
): SentryAttributionAttributes {
  return definedAttributes({
    conversation_id: context.conversationId,
    channel_id: context.conversationId,
    session_key: context.sessionKey,
    message_id: context.messageId,
    platform: context.platform,
    conversation_kind: context.conversationKind,
    user_id: context.userId,
    thread_id: context.threadTs,
    provider: context.provider,
    model: context.model,
  });
}

export function registerTraceAttribution(
  span: { setAttributes(attributes: SentryAttributionAttributes): unknown },
  attributes: SentryAttributionAttributes,
): void {
  span.setAttributes(attributes);
  const traceId = Sentry.spanToJSON(span as Parameters<typeof Sentry.spanToJSON>[0]).trace_id;
  if (!traceId) return;

  const now = Date.now();
  pruneExpiredTraceAttributions(now);
  traceAttribution.set(traceId, {
    attributes: { ...traceAttribution.get(traceId)?.attributes, ...attributes },
    expiresAt: now + TRACE_ATTRIBUTION_TTL_MS,
  });
}

export function applyRunScope(scope: Scope, context: SentryRunScopeContext): void {
  const attributes = createRunScopeAttributes(context);

  for (const [key, value] of Object.entries(attributes)) {
    scope.setTag(key, value);
  }
  scope.setAttributes(attributes);
  scope.setUser({ id: String(attributes.user_id) });
  scope.setConversationId(String(attributes.session_key));
  scope.setContext("agent_run", {
    conversationId: attributes.conversation_id,
    channelId: attributes.channel_id,
    sessionKey: attributes.session_key,
    messageId: attributes.message_id,
    threadId: attributes.thread_id,
    platform: context.platform,
    conversationKind: context.conversationKind,
    provider: context.provider,
    model: context.model,
  });
}

function definedAttributes(
  attributes: Record<string, string | number | boolean | undefined>,
): SentryAttributionAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
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
    user: event.user ? { id: event.user.id, username: event.user.username } : undefined,
    server_name: undefined,
  };

  if (sanitized.message) {
    sanitized.message = sanitizeTelemetryString(sanitized.message);
  }

  if (sanitized.logentry) {
    sanitized.logentry = {
      ...sanitized.logentry,
      message: sanitized.logentry.message
        ? sanitizeTelemetryString(sanitized.logentry.message)
        : undefined,
    };
  }

  if (sanitized.exception?.values) {
    sanitized.exception.values = sanitized.exception.values.map((value) => ({
      ...value,
      value: value.value ? sanitizeTelemetryString(value.value) : value.value,
      stacktrace: value.stacktrace
        ? {
            ...value.stacktrace,
            frames: value.stacktrace.frames?.map((frame) => ({
              ...frame,
              filename: frame.filename ? sanitizeTelemetryString(frame.filename) : frame.filename,
              abs_path: frame.abs_path ? sanitizeTelemetryString(frame.abs_path) : frame.abs_path,
              vars: undefined,
            })),
          }
        : value.stacktrace,
    }));
  }

  return sanitized;
}

export function applySpanAttribution<T extends SentrySpanPayload>(span: T): T {
  const attributes = getTraceAttribution(span.trace_id);
  if (!attributes) return span;
  return {
    ...span,
    data: {
      ...span.data,
      ...attributes,
    },
  };
}

function sanitizeTransactionEvent<T extends SentryTransactionPayload>(event: T): T | null {
  const sanitized = sanitizeEvent(event);
  if (!sanitized) return null;

  const traceContext = sanitized.contexts?.trace;
  const traceId = traceContext?.trace_id;
  if (typeof traceId !== "string") return sanitized;
  const attributes = getTraceAttribution(traceId);
  if (!attributes) return sanitized;

  const entries = (sanitized as { entries?: Array<{ type?: string; data?: unknown }> }).entries;
  for (const entry of entries ?? []) {
    if (entry.type !== "spans" || !Array.isArray(entry.data)) continue;
    entry.data = entry.data.map((span: SentrySpanPayload) => applySpanAttribution(span));
  }

  traceAttribution.delete(traceId);
  return sanitized;
}

export function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") {
    return null;
  }

  return {
    ...breadcrumb,
    message: breadcrumb.message ? sanitizeTelemetryString(breadcrumb.message) : breadcrumb.message,
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
    return sanitizeTelemetryString(value);
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

function getTraceAttribution(traceId: string): SentryAttributionAttributes | undefined {
  const entry = traceAttribution.get(traceId);
  if (!entry) return undefined;
  if (entry.expiresAt > Date.now()) return entry.attributes;
  traceAttribution.delete(traceId);
  return undefined;
}

function pruneExpiredTraceAttributions(now: number): void {
  for (const [traceId, entry] of traceAttribution) {
    if (entry.expiresAt <= now) traceAttribution.delete(traceId);
  }
}

function isSensitiveKey(key?: string): boolean {
  if (!key) return false;
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
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

export function sanitizeTelemetryString(value: string): string {
  let sanitized = value.replace(new RegExp(ABSOLUTE_PATH_PATTERN, "g"), REDACTED_PATH);
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(new RegExp(pattern, "g"), REDACTED);
  }
  if (sanitized.length > MAX_STRING_LENGTH) {
    return `${sanitized.slice(0, MAX_STRING_LENGTH)}… [truncated ${sanitized.length - MAX_STRING_LENGTH} chars]`;
  }
  return sanitized;
}
