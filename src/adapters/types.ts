import type {
  ChatToolResult,
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  SubagentProgressSnapshot,
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

interface ProgressiveStreamTransport {
  start(text: string): Promise<string>;
  append(messageId: string, delta: string): Promise<void>;
  stop(messageId: string): Promise<void>;
}

export interface ProgressiveRendererPlatform {
  label: string;
  maxLength: number;
  initialResponseId?: string | null;
  formatContinuation: (partNum: number) => string;
  errorPrefix: string;
  sanitize?: (text: string) => string;
  workingIndicator?: string;
  formatProvisional?: (text: string, working: boolean) => string;
  prepareSource?: (text: string, working: boolean) => string;
  onWorkingChanged?: (working: boolean, responseId: string | null) => Promise<void>;
  setTyping?: (isTyping: boolean, responseId: string | null) => Promise<void>;
  onFinish?: (text: string, responseId: string | null) => void;
  /** Whether `respond` calls are complete messages that should be logged immediately. */
  logIntermediateResponses?: boolean;
  /** Whether the platform accepts incremental response deltas. */
  supportsDeltas?: boolean;
  /** Native stream operations, when this reply target supports them. */
  stream?: ProgressiveStreamTransport;
  /** Re-render a finished response when the provisional stream lacked structure. */
  needsCanonicalRender?: (text: string) => boolean;
  formatSubagentProgress?: (progress: SubagentProgressSnapshot) => string;
  typing?: {
    send: () => Promise<unknown>;
    intervalMs: number;
    stopOnSend?: boolean;
  };
  formatToolResult: (result: ChatToolResult) => string;
  /** Stable platform context plus the current response identity for error reporting. */
  responseErrorContext?: (
    responseId: string | null,
  ) => Omit<ChatResponseErrorContext, "operation" | "extra">;
  /** @deprecated Provide `responseErrorContext`; the renderer now owns reporting. */
  reportError?: (
    err: unknown,
    operation: ChatResponseErrorOperation,
    extra: Record<string, unknown>,
    responseId: string | null,
  ) => void;
  notifySendFailure?: (errorMessage: string) => Promise<void>;
  post: (text: string) => Promise<string>;
  update: (id: string, text: string) => Promise<void>;
  postExtra: (text: string, responseId: string | null) => Promise<string | number | void>;
  postDiagnostic?: (
    text: string,
    options: { style?: "muted" | "error" },
    responseId: string | null,
  ) => Promise<Array<string | number>>;
  delete?: (id: string) => Promise<void>;
  deleteExtra?: (id: string | number) => Promise<void>;
  logBotResponse?: (text: string, id: string) => void;
  uploadFile?: (filePath: string, title?: string) => Promise<void>;
  uploadFallbackNote?: (name: string) => string;
  react?: (emoji: string) => Promise<void>;
  /** Handle a Slack-style length rejection and return the canonical fallback text. */
  handleTooLong?: (
    text: string,
    operation: "render" | "replace",
    options: { createOverflowLink?: () => string } | undefined,
    responseId: string | null,
    write: (text: string) => Promise<void>,
    getResponseId: () => string | null,
  ) => Promise<{ text: string; prefixLength?: number }>;
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
