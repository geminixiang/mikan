import type { Bot, PlatformEventContext, BotEvent, BotHandler } from "../adapter.js";

export type ChatResponseErrorOperation =
  | "respond"
  | "replace_response"
  | "respond_diagnostic"
  | "set_working";

export interface ChatResponseErrorContext {
  platform: string;
  conversationId: string;
  messageId: string;
  sessionKey: string;
  conversationKind: string;
  operation: ChatResponseErrorOperation;
  channelId?: string;
  chatId?: number;
  responseMessageId?: string | number | null;
  threadTs?: string;
  replyTargetId?: string;
  replyToId?: number | null;
  isThreaded?: boolean;
  extra?: Record<string, unknown>;
}

export type ChatResponseErrorReporter = (
  err: unknown,
  operation: ChatResponseErrorOperation,
  extra?: Record<string, unknown>,
) => void;

export interface RetryOptions {
  /** Predicate that returns true when an error is worth retrying (rate limit, transient 5xx, etc.). */
  isRateLimited: (err: Error) => boolean;
  /** Total attempts including the first call. */
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface ResolveStopTargetInput {
  handler: BotHandler;
  conversationId: string;
  /** Session key derived from the current message; checked first when present. */
  sessionKey?: string;
}

export interface BufferedResponseStreamOptions {
  minFlushIntervalMs?: number;
  minFlushChars?: number;
  now?: () => number;
}

export interface BufferedResponseStreamSink {
  flush(text: string): Promise<void>;
  finish(text: string): Promise<void>;
}

export interface MessageIntakeOptions<TEvent extends BotEvent> {
  eventBase: TEvent;
  workingDir: string | undefined;
  isAutoReplyCandidate: boolean;
  logEntryBase: Record<string, unknown>;
  log?: (entry: Record<string, unknown>) => void;
  processAttachments: () => Promise<unknown[]>;
  queueKey: string;
  enqueue: (queueKey: string, work: () => Promise<void>) => void;
  handler: BotHandler;
  bot: Bot;
  createContext: (event: TEvent) => PlatformEventContext;
  beforeEnqueue?: (event: TEvent) => Promise<boolean> | boolean;
  onNotTriggered?: () => void;
  deferAttachmentsUntilRun?: boolean;
}
