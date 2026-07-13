import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
} from "../adapter.js";

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
  handler: MessagingEventHandler;
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

/** How intake resolved a message. Callers branch on this instead of passing callbacks. */
export type MessageIntakeOutcome = "magic-word" | "not-triggered" | "rejected-busy" | "enqueued";

/** Platform policy for the magic-word step, stated as data. */
export interface MagicWordIntakeOptions {
  /**
   * Raw user-typed text to match when `eventBase.text` is decorated for the
   * agent (e.g. GitHub review-comment framing). Defaults to `eventBase.text`.
   */
  text?: string;
  /**
   * Whether the message addressed the bot (mention, DM, slash form). The idle
   * "Nothing running." reply is suppressed for unaddressed messages.
   */
  addressed: boolean;
  /**
   * How far a stop may widen when the direct session key is not running:
   * "top-level" widens to the single running scoped session only from the
   * persistent conversation session, "always" widens unconditionally,
   * "never" stops only exact matches.
   */
  scopeFallback: "top-level" | "always" | "never";
}

export interface MessageIntakeOptions<TEvent extends ConversationEvent> {
  eventBase: TEvent;
  workingDir: string | undefined;
  isAutoReplyCandidate: boolean;
  magicWord: MagicWordIntakeOptions;
  /**
   * "reject" bounces a new message while its session is already running
   * (with an "Already working" reply); "queue" lines it up behind the run.
   */
  busyPolicy: "queue" | "reject";
  logEntryBase: Record<string, unknown>;
  log?: (entry: Record<string, unknown>) => void;
  processAttachments: () => Promise<unknown[]>;
  queueKey: string;
  enqueue: (queueKey: string, work: () => Promise<void>) => void;
  handler: MessagingEventHandler;
  bot: MessagingBot;
  createContext: (event: TEvent) => ConversationContext;
  deferAttachmentsUntilRun?: boolean;
}
