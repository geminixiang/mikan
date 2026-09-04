/**
 * Helpers shared across platform adapters.
 *
 * The agent runner is platform-agnostic: it hands strings and structured tool
 * results to each adapter, which decides how to split, format, and route them.
 * The split/normalize logic itself doesn't differ across platforms — only the
 * markup wrappers — so it lives here once.
 */

import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MessagingEventHandler, OfficeAddress } from "../adapter.js";
import { sameOffice, type Office } from "../office/index.js";
import * as log from "../log.js";
import { reportUserFacingError } from "../observability/sentry.js";
export type {
  ChatResponseErrorContext,
  ChatResponseErrorOperation,
  ChatResponseErrorReporter,
  IncomingAttachment,
  ResolveStopTargetInput,
  RetryOptions,
  SavedAttachments,
} from "./types.js";
import type {
  ChatResponseErrorContext,
  ChatResponseErrorReporter,
  IncomingAttachment,
  RetryOptions,
  ResolveStopTargetInput,
  SavedAttachments,
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

export class MessagingIntakeTracker {
  private accepting = true;
  private active = new Set<Promise<void>>();

  constructor(private readonly name: string) {}

  run(work: () => Promise<void> | void): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    let result: Promise<void> | void;
    try {
      result = work();
    } catch (error) {
      result = Promise.reject(error);
    }
    const task = Promise.resolve(result).catch((error) => {
      log.logWarning(
        `${this.name} intake error`,
        error instanceof Error ? error.message : String(error),
      );
    });
    this.active.add(task);
    return task.finally(() => this.active.delete(task));
  }

  async close(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled(this.active);
  }
}

export class MessagingEventQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private accepting = true;
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly name: string = "") {}

  enqueue(work: () => Promise<void>): boolean {
    if (!this.accepting) return false;
    this.queue.push(work);
    this.processNext();
    return true;
  }

  size(): number {
    return this.queue.length;
  }

  close(): Promise<void> {
    this.accepting = false;
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
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
    if (this.queue.length > 0) {
      this.processNext();
      return;
    }
    for (const resolve of this.drainWaiters.splice(0)) resolve();
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
 * Append a JSON-serializable entry to the office's `log.jsonl`,
 * materializing the office on first use. This is the single write path every
 * adapter uses for human-readable message history.
 */
export function appendChannelLog(office: Office, entry: object): void {
  office.ensure();
  appendFileSync(office.logPath, `${JSON.stringify(entry)}\n`);
}

/**
 * Save incoming platform files under the office's attachments directory.
 *
 * The one owner of the attachment convention: sanitized
 * `<timestamp>_<name>` filenames, the `<office key>/attachments/<file>`
 * workspace-relative localPath the agent reads, and office materialization
 * before the first write. Download mechanics and failure policy stay with
 * the adapter — failures come back in `failed` for the caller to throw or
 * warn about, matching its platform's behavior.
 */
export async function saveIncomingAttachments(
  office: Office,
  items: readonly IncomingAttachment[],
): Promise<SavedAttachments> {
  if (items.length === 0) return { saved: [], failed: [] };
  // Attachment downloads can be the office's first write; materialize (and
  // register) it before composing office-relative attachment paths.
  office.ensure();
  await mkdir(office.attachmentsDir, { recursive: true });

  // Results keep the caller's item order regardless of download completion
  // order — platform message logs list attachments as the platform sent them.
  const results = await Promise.all(
    items.map(async (item) => {
      const sanitized = item.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${item.timestampMs ?? Date.now()}_${sanitized}`;
      try {
        await item.download(join(office.attachmentsDir, filename));
        return {
          saved: { original: item.name, localPath: `${office.key}/attachments/${filename}` },
        };
      } catch (error) {
        return { failed: { name: item.name, error } };
      }
    }),
  );
  return {
    saved: results.flatMap((result) => (result.saved ? [result.saved] : [])),
    failed: results.flatMap((result) => (result.failed ? [result.failed] : [])),
  };
}

/** Convenience for appending the bot's own outbound message. */
export function appendBotResponseLog(
  office: Office,
  text: string,
  ts: string,
  threadTs?: string,
  extraFields: Record<string, unknown> = {},
): void {
  appendChannelLog(office, {
    date: new Date().toISOString(),
    ts,
    ...(threadTs ? { threadTs } : {}),
    user: "bot",
    text,
    attachments: [],
    isMessagingBot: true,
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
  const { handler, address, sessionKey } = input;

  if (sessionKey && handler.isRunning(address, sessionKey)) return sessionKey;
  if (handler.isRunning(address, address.conversationId)) return address.conversationId;
  return null;
}

/**
 * Return the single running scoped session for this office, or null when there
 * are zero or multiple matches. Another platform's identically named
 * conversation is a different office and is never a stop target.
 */
export function resolveOnlyScopedStopTarget(
  handler: MessagingEventHandler,
  address: OfficeAddress,
): string | null {
  const runningScopes = handler
    .getRunningSessions()
    .filter((session) => sameOffice(session.address, address))
    .map((session) => session.sessionKey)
    .filter((key) => key.startsWith(`${address.conversationId}:`));

  return runningScopes.length === 1 ? (runningScopes[0] ?? null) : null;
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
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.from(buffer));
}
