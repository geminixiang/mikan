import type { Breadcrumb, Event, Scope } from "@sentry/node";
import { beforeEach, describe, expect, test, vi } from "vitest";

const sentryMock = vi.hoisted(() => {
  const scope = {
    setLevel: vi.fn(),
    setTag: vi.fn(),
    setFingerprint: vi.fn(),
    setContext: vi.fn(),
    setAttributes: vi.fn(),
    setUser: vi.fn(),
  };
  return {
    captureException: vi.fn(() => "event-id"),
    spanToJSON: vi.fn(() => ({ trace_id: "trace-1" })),
    scope,
  };
});

vi.mock("@sentry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/node")>();
  return {
    ...actual,
    captureException: sentryMock.captureException,
    spanToJSON: sentryMock.spanToJSON,
    withScope: vi.fn((callback: (scope: Scope) => unknown) =>
      callback(sentryMock.scope as unknown as Scope),
    ),
  };
});

import {
  applyRunScope,
  applySpanAttribution,
  createRunAttributionAttributes,
  createSentryInitOptions,
  metricAttributes,
  registerTraceAttribution,
  reportUserFacingError,
  sanitizeBreadcrumb,
  sanitizeEvent,
  sanitizeValue,
} from "../observability/sentry.js";

describe("Sentry initialization", () => {
  test("disables only OpenAI auto-instrumentation", () => {
    const options = createSentryInitOptions("https://public@example.invalid/1");
    const integrations = [{ name: "Http" }, { name: "OpenAI" }, { name: "OnUnhandledRejection" }];

    expect(options.integrations(integrations)).toEqual([
      { name: "Http" },
      { name: "OnUnhandledRejection" },
    ]);
  });
});

describe("reportUserFacingError", () => {
  beforeEach(() => {
    sentryMock.captureException.mockClear();
    sentryMock.scope.setLevel.mockClear();
    sentryMock.scope.setTag.mockClear();
    sentryMock.scope.setFingerprint.mockClear();
    sentryMock.scope.setContext.mockClear();
    sentryMock.scope.setAttributes.mockClear();
    sentryMock.scope.setUser.mockClear();
  });

  test("captures with user-facing tags and sanitized context", () => {
    const id = reportUserFacingError(new Error("boom"), {
      domain: "chat_platform",
      surface: "chat_response",
      operation: "respond",
      severity: "warning",
      platform: "slack",
      tags: { retryable: true, status: 500 },
      context: {
        text: "secret prompt text",
        safeCount: 2,
        token: "ghp_abcdefghijklmnopqrstuvwxyz",
      },
    });

    expect(id).toBe("event-id");
    expect(sentryMock.scope.setLevel).toHaveBeenCalledWith("warning");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("user_facing", "true");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("error_domain", "chat_platform");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("operation", "respond");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("platform", "slack");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("retryable", "true");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("status", "500");
    expect(sentryMock.scope.setContext).toHaveBeenCalledWith(
      "user_facing_error",
      expect.objectContaining({
        domain: "chat_platform",
        surface: "chat_response",
        operation: "respond",
        severity: "warning",
        safeCount: 2,
        text: "[Redacted text; length=18]",
        token: "[Redacted token; length=30]",
      }),
    );
    expect(sentryMock.captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  test("sets optional tags and fingerprint", () => {
    reportUserFacingError(new Error("llm"), {
      domain: "llm",
      surface: "assistant_response",
      operation: "llm_turn",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      toolName: "bash",
      stopReason: "error",
      fingerprint: ["llm", "anthropic", "error"],
    });

    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("provider", "anthropic");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("model", "claude-sonnet-4-6");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("tool", "bash");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("stop_reason", "error");
    expect(sentryMock.scope.setFingerprint).toHaveBeenCalledWith(["llm", "anthropic", "error"]);
  });

  test("does not capture expected errors", () => {
    const id = reportUserFacingError(new Error("expected"), {
      domain: "mikan",
      surface: "cli",
      operation: "validation",
      expected: true,
    });

    expect(id).toBeUndefined();
    expect(sentryMock.captureException).not.toHaveBeenCalled();
  });
});

describe("sanitizeValue", () => {
  test("redacts known sensitive fields", () => {
    expect(sanitizeValue("hello world", "text")).toBe("[Redacted text; length=11]");
    expect(
      sanitizeValue(
        {
          prompt: "secret",
          result: { value: "another secret" },
        },
        "payload",
      ),
    ).toEqual({
      prompt: "[Redacted prompt; length=6]",
      result: "[Redacted result; keys=1]",
    });
  });

  test("redacts local paths and tokens in plain strings", () => {
    expect(sanitizeValue("/Users/alice/project/file.ts sk-test-token-123456789012")).toBe(
      "[REDACTED_PATH] [REDACTED]",
    );
  });

  test("redacts integration secret-shaped keys", () => {
    expect(
      sanitizeValue({
        accessToken: "abc",
        refreshToken: "def",
        api_key: "ghi",
        client_secret: "jkl",
        url: "https://example.com/x",
      }),
    ).toEqual({
      accessToken: "[Redacted accessToken; length=3]",
      refreshToken: "[Redacted refreshToken; length=3]",
      api_key: "[Redacted api_key; length=3]",
      client_secret: "[Redacted client_secret; length=3]",
      url: "[Redacted url; length=21]",
    });
  });
});

describe("sanitizeBreadcrumb", () => {
  test("drops console breadcrumbs", () => {
    const breadcrumb: Breadcrumb = { category: "console", message: "secret" };
    expect(sanitizeBreadcrumb(breadcrumb)).toBeNull();
  });

  test("redacts sensitive http breadcrumb fields", () => {
    const breadcrumb: Breadcrumb = {
      category: "http",
      message: "POST https://api.anthropic.com/v1/messages",
      data: { status_code: 200, url: "https://api.anthropic.com/v1/messages" },
    };

    expect(sanitizeBreadcrumb(breadcrumb)).toEqual({
      category: "http",
      message: "POST https://api.anthropic.com/v1/messages",
      data: { status_code: 200, url: "[Redacted url; length=37]" },
    });
  });
});

describe("sanitizeEvent", () => {
  test("removes user, server name, headers, and sensitive extras", () => {
    const event: Event = {
      event_id: "123",
      user: { id: "U1", username: "alice" },
      server_name: "Alice-MacBook-Air.local",
      request: {
        headers: { authorization: "Bearer secret" },
        data: { prompt: "do not leak" },
      },
      extra: {
        systemPrompt: "hidden",
        safe: "visible",
      },
      breadcrumbs: [
        { category: "console", message: "secret" },
        { category: "http", message: "GET https://example.com" },
      ],
    };

    const sanitized = sanitizeEvent(event);
    expect(sanitized?.user).toBeUndefined();
    expect(sanitized?.server_name).toBeUndefined();
    expect(sanitized?.request?.headers).toBeUndefined();
    expect(sanitized?.request?.data).toBe("[Redacted body; keys=1]");
    expect(sanitized?.extra).toEqual({
      systemPrompt: "[Redacted systemPrompt; length=6]",
      safe: "visible",
    });
    expect(sanitized?.breadcrumbs).toEqual([
      { category: "http", message: "GET https://example.com" },
    ]);
  });
});

describe("metricAttributes", () => {
  test("drops undefined values", () => {
    expect(
      metricAttributes({
        channel_id: "C1",
        session_id: undefined,
        llm_calls: 2,
        error: false,
      }),
    ).toEqual({
      channel_id: "C1",
      llm_calls: 2,
      error: false,
    });
  });
});

describe("run attribution", () => {
  beforeEach(() => {
    sentryMock.scope.setTag.mockClear();
    sentryMock.scope.setAttributes.mockClear();
    sentryMock.scope.setUser.mockClear();
    sentryMock.scope.setContext.mockClear();
    sentryMock.spanToJSON.mockClear();
  });

  test("builds consistent discover-friendly attributes", () => {
    expect(
      createRunAttributionAttributes({
        conversationId: "C1",
        sessionKey: "C1:T1",
        messageId: "M1",
        platform: "slack",
        userId: "U1",
        userName: undefined,
        threadTs: "T1",
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toEqual({
      conversation_id: "C1",
      channel_id: "C1",
      session_key: "C1:T1",
      message_id: "M1",
      platform: "slack",
      user_id: "U1",
      thread_ts: "T1",
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  test("applies attribution to scope tags and attributes", () => {
    applyRunScope(sentryMock.scope as unknown as Scope, {
      conversationId: "C1",
      sessionKey: "C1:T1",
      messageId: "M1",
      platform: "slack",
      userId: "U1",
      userName: "alice",
    });

    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("conversation_id", "C1");
    expect(sentryMock.scope.setTag).toHaveBeenCalledWith("session_key", "C1:T1");
    expect(sentryMock.scope.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "C1", channel_id: "C1", user_id: "U1" }),
    );
    expect(sentryMock.scope.setUser).toHaveBeenCalledWith({ id: "U1", username: "alice" });
  });

  test("propagates root attribution onto child spans", () => {
    const rootSpan = { setAttributes: vi.fn() };
    registerTraceAttribution(rootSpan, { conversation_id: "C1", session_key: "C1:T1" });

    expect(rootSpan.setAttributes).toHaveBeenCalledWith({
      conversation_id: "C1",
      session_key: "C1:T1",
    });
    expect(
      applySpanAttribution({
        trace_id: "trace-1",
        span_id: "span-1",
        start_timestamp: 1,
        data: { "sentry.op": "gen_ai.chat" },
      }),
    ).toEqual({
      trace_id: "trace-1",
      span_id: "span-1",
      start_timestamp: 1,
      data: {
        "sentry.op": "gen_ai.chat",
        conversation_id: "C1",
        session_key: "C1:T1",
      },
    });
  });

  test("drops expired trace attribution", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      registerTraceAttribution({ setAttributes: vi.fn() }, { conversation_id: "C1" });
      vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));

      const span = {
        trace_id: "trace-1",
        span_id: "span-1",
        start_timestamp: 1,
        data: { "sentry.op": "gen_ai.chat" },
      };
      expect(applySpanAttribution(span)).toEqual(span);
    } finally {
      vi.useRealTimers();
    }
  });
});
