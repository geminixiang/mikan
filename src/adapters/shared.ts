/**
 * Helpers shared across platform adapters.
 *
 * The agent runner is platform-agnostic: it hands strings and structured tool
 * results to each adapter, which decides how to split, format, and route them.
 * The split/normalize logic itself doesn't differ across platforms — only the
 * markup wrappers — so it lives here once.
 */

import { appendFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { BotHandler } from "../adapter.js";
import { ensureDirExists } from "../utils/file-guards.js";
import * as log from "../log.js";
import { reportUserFacingError } from "../observability/sentry.js";
export type {
  ChatResponseErrorContext,
  ChatResponseErrorOperation,
  ChatResponseErrorReporter,
  ResolveStopTargetInput,
  RetryOptions,
} from "./types.js";
import type {
  ChatResponseErrorContext,
  ChatResponseErrorOperation,
  ChatResponseErrorReporter,
  RetryOptions,
  ResolveStopTargetInput,
} from "./types.js";

export function createChatResponseErrorReporter(
  resolve: () => Omit<ChatResponseErrorContext, "operation" | "extra">,
): ChatResponseErrorReporter {
  return (err, operation, extra) => {
    reportChatResponseError(err, { ...resolve(), operation, extra });
  };
}

function reportChatResponseError(err: unknown, context: ChatResponseErrorContext): void {
  reportUserFacingError(err, {
    domain: "chat_platform",
    surface: "chat_response",
    operation: context.operation,
    severity: context.operation === "set_working" ? "warning" : "error",
    platform: context.platform,
    context: {
      conversationId: context.conversationId,
      channelId: context.channelId,
      chatId: context.chatId,
      messageId: context.messageId,
      sessionKey: context.sessionKey,
      responseMessageId: context.responseMessageId,
      threadTs: context.threadTs,
      replyTargetId: context.replyTargetId,
      replyToId: context.replyToId,
      conversationKind: context.conversationKind,
      isThreaded: context.isThreaded,
      ...context.extra,
    },
  });
}

export class ChannelQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(private readonly name: string = "") {}

  enqueue(work: () => Promise<void>): void {
    this.queue.push(work);
    this.processNext();
  }

  size(): number {
    return this.queue.length;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const work = this.queue.shift()!;
    try {
      await work();
    } catch (err) {
      log.logWarning(
        `${this.name ? this.name + " " : ""}queue error`,
        err instanceof Error ? err.message : String(err),
      );
    }
    this.processing = false;
    this.processNext();
  }
}

// RetryOptions is defined in ./types.ts and re-exported from the top of this file.

/**
 * Run `fn` and retry with exponential backoff when its error matches
 * `isRateLimited`. Other errors propagate immediately. Each platform supplies
 * its own predicate so we don't have to know every SDK's error shape here.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !opts.isRateLimited(lastError)) {
        throw lastError;
      }

      const delay = baseDelayMs * Math.pow(2, attempt);
      log.logWarning(
        `Retrying after error in ${delay}ms (attempt ${attempt + 1}/${maxAttempts}): ${lastError.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Split `text` into chunks no larger than `limit`, appending a continuation
 * marker (e.g. `_(continued 1)_`) at the end of every part except the last.
 *
 * Each adapter passes its own `formatContinuation` so the marker uses the
 * platform's italic / emphasis convention.
 */
export function splitText(
  text: string,
  limit: number,
  formatContinuation: (partNum: number) => string,
): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let remaining = text;
  let partNum = 1;
  while (remaining.length > 0) {
    const suffixReserve = formatContinuation(partNum).length + 8;
    const chunkLimit = Math.max(1, limit - suffixReserve);
    const chunk = remaining.slice(0, chunkLimit);
    remaining = remaining.slice(chunkLimit);
    const suffix = remaining.length > 0 ? `\n${formatContinuation(partNum)}` : "";
    parts.push(chunk + suffix);
    partNum++;
  }
  return parts;
}

/**
 * Append a JSON-serializable entry to `${workingDir}/${channel}/log.jsonl`,
 * creating the directory on first use. This is the single write path every
 * adapter uses for human-readable message history.
 */
export function appendChannelLog(workingDir: string, channel: string, entry: object): void {
  const dir = join(workingDir, channel);
  ensureDirExists(dir);
  appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
}

/** Convenience for appending the bot's own outbound message. */
export function appendBotResponseLog(
  workingDir: string,
  channel: string,
  text: string,
  ts: string,
  threadTs?: string,
  extraFields: Record<string, unknown> = {},
): void {
  appendChannelLog(workingDir, channel, {
    date: new Date().toISOString(),
    ts,
    ...(threadTs ? { threadTs } : {}),
    user: "bot",
    text,
    attachments: [],
    isBot: true,
    ...extraFields,
  });
}

// ResolveStopTargetInput is defined in ./types.ts and re-exported from the top of this file.

/**
 * Pick which session key a `/stop` should target without applying any
 * platform-specific fallback policy. Order:
 *   1. The provided sessionKey, if running.
 *   2. The bare conversationId, if running.
 */
export function resolveStopTarget(input: ResolveStopTargetInput): string | null {
  const { handler, conversationId, sessionKey } = input;

  if (sessionKey && handler.isRunning(sessionKey)) return sessionKey;
  if (handler.isRunning(conversationId)) return conversationId;
  return null;
}

/**
 * Return the single running scoped session for this conversation, or null when
 * there are zero or multiple matches.
 */
export function resolveOnlyScopedStopTarget(
  handler: BotHandler,
  conversationId: string,
): string | null {
  const runningScopes = handler
    .getRunningSessions()
    .map((s) => s.sessionKey)
    .filter((k) => k.startsWith(`${conversationId}:`));

  return runningScopes.length === 1 ? runningScopes[0] : null;
}

/**
 * Render tool-call args for human display. Drops `label` (already in the
 * heading) and folds `path` + `offset`/`limit` into a single `path:start-end`
 * line. Pure data normalization with no platform-specific markup.
 */
export function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const lines: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "label" || key === "offset" || key === "limit") continue;

    if (key === "path" && typeof value === "string") {
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      lines.push(
        offset !== undefined && limit !== undefined
          ? `${value}:${offset}-${offset + limit}`
          : value,
      );
      continue;
    }

    lines.push(typeof value === "string" ? value : JSON.stringify(value));
  }

  return lines.join("\n");
}

/**
 * Fetch `url` and write the response body to `destPath`, creating parent
 * directories as needed. Throws on non-2xx responses or write failures.
 */
export async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  await mkdir(join(destPath, ".."), { recursive: true });
  await writeFile(destPath, Buffer.from(buffer));
}
