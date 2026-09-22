import type {
  ChatToolResult,
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  OfficeAddress,
  SubagentProgressSnapshot,
} from "./index.js";
import type { Attachment } from "../types.js";

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
  isRateLimited: (err: Error) => boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export interface ResolveStopTargetInput {
  handler: MessagingEventHandler;
  address: OfficeAddress;
  sessionKey?: string;
}

export interface HandleTooLongInput {
  text: string;
  operation: "render" | "replace";
  options: { createOverflowLink?: () => string } | undefined;
  responseId: string | null;
  write: (text: string) => Promise<void>;
  getResponseId: () => string | null;
}

interface ProgressiveStreamTransport {
  start(text: string): Promise<string>;
  append(messageId: string, delta: string): Promise<void>;
  stop(messageId: string): Promise<void>;
  minDeltaChars?: number;
}

export interface ProgressiveRendererPlatform {
  label: string;
  maxLength: number;
  flushIntervalMs?: number;
  initialResponseId?: string | null;
  formatContinuation: (partNum: number) => string;
  errorPrefix: string;
  sanitize?: (text: string) => string;
  workingIndicator?: string;
  formatProvisional?: (text: string, working: boolean) => string;
  prepareSource?: (text: string, working: boolean) => string;
  onWorkingChanged?: (working: boolean, responseId: string | null) => Promise<void>;
  setTyping?: (isTyping: boolean, responseId: string | null) => Promise<void>;
  onFinish?: (text: string, responseId: string | null) => void | Promise<void>;
  logIntermediateResponses?: boolean;
  supportsDeltas?: boolean;
  stream?: ProgressiveStreamTransport;
  needsCanonicalRender?: (text: string) => boolean;
  formatSubagentProgress?: (progress: SubagentProgressSnapshot) => string;
  typing?: {
    send: () => Promise<unknown>;
    intervalMs: number;
    stopOnSend?: boolean;
  };
  formatToolResult: (result: ChatToolResult) => string;
  responseErrorContext?: (
    responseId: string | null,
  ) => Omit<ChatResponseErrorContext, "operation" | "extra">;
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
  isTooLongError?: (err: unknown) => boolean;
  handleTooLong?: (input: HandleTooLongInput) => Promise<{ text: string; prefixLength?: number }>;
}

export type MessageIntakeOutcome = "magic-word" | "not-triggered" | "rejected-busy" | "enqueued";

export interface MagicWordIntakeOptions {
  text?: string;
  addressed: boolean;
  scopeFallback: "top-level" | "always" | "never";
}

export interface IncomingAttachment {
  name: string;
  timestampMs?: number;
  download(destPath: string): Promise<void>;
}

export interface SavedAttachments {
  saved: Attachment[];
  failed: { name: string; error: unknown }[];
}

export interface MessageIntakeOptions<TEvent extends ConversationEvent> {
  eventBase: TEvent;
  addressed: boolean;
  magicWord: MagicWordIntakeOptions;
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

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  startLine: number;
  endLine: number;
}
