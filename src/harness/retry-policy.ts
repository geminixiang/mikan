/**
 * Retry policy for transient provider errors.
 *
 * Ported from pi-coding-agent's `AgentSession._isRetryableError` /
 * `_isNonRetryableProviderLimitError` / backoff calculation — those were
 * private methods, not a public export, so this is a deliberate,
 * attributed port rather than a reuse-by-import.
 */
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

const RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/**
 * Whether an assistant message's failure is a transient provider error worth
 * retrying. Context overflow is excluded — that's handled by compaction
 * instead, since retrying without shrinking context would fail identically.
 */
export function isRetryableError(message: AssistantMessage, contextWindow: number): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  if (isContextOverflow(message, contextWindow)) return false;
  if (NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(message.errorMessage)) return false;
  return RETRYABLE_ERROR_PATTERN.test(message.errorMessage);
}

/** Exponential backoff: baseDelayMs * 2^(attempt-1), so attempt 1 waits baseDelayMs. */
export function computeBackoffDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** (attempt - 1);
}
