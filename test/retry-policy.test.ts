import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { computeBackoffDelayMs, isRetryableError } from "../src/harness/retry-policy.js";

function assistantError(
  errorMessage: string,
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
    ...overrides,
  };
}

describe("isRetryableError", () => {
  test.each([
    "overloaded_error: the server is overloaded",
    "rate limit exceeded, please retry",
    "429 Too Many Requests",
    "500 Internal Server Error",
    "503 Service Unavailable",
    "network error: connection refused",
    "socket hang up",
    "fetch failed",
    "request timed out",
  ])("treats %s as retryable", (message) => {
    expect(isRetryableError(assistantError(message), 200_000)).toBe(true);
  });

  test.each([
    "insufficient_quota: you have exceeded your current quota",
    "Monthly usage limit reached",
    "billing: please add a payment method",
  ])("does not retry non-retryable quota/billing errors: %s", (message) => {
    expect(isRetryableError(assistantError(message), 200_000)).toBe(false);
  });

  test("does not retry a successful message", () => {
    const message = assistantError("", { stopReason: "stop", errorMessage: undefined });
    expect(isRetryableError(message, 200_000)).toBe(false);
  });

  test("does not retry a message with no error text", () => {
    const message = assistantError("", { errorMessage: undefined });
    expect(isRetryableError(message, 200_000)).toBe(false);
  });

  test("does not retry context overflow — that's compaction's job", () => {
    const message = assistantError("prompt is too long: 250000 tokens > 200000 maximum");
    expect(isRetryableError(message, 200_000)).toBe(false);
  });

  test("does not retry an unrecognized error message", () => {
    const message = assistantError("something completely unexpected happened");
    expect(isRetryableError(message, 200_000)).toBe(false);
  });
});

describe("computeBackoffDelayMs", () => {
  test("doubles the delay each attempt starting from baseDelayMs", () => {
    expect(computeBackoffDelayMs(1, 2000)).toBe(2000);
    expect(computeBackoffDelayMs(2, 2000)).toBe(4000);
    expect(computeBackoffDelayMs(3, 2000)).toBe(8000);
  });
});
