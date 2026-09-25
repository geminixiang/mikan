import { appendFileSync, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { dirname, join } from "node:path";
import type { MessagingEventHandler, OfficeAddress } from "../types.js";
import { sameOffice } from "../office/index.js";
import type { Office } from "../office/types.js";
import * as log from "../log.js";
import { reportUserFacingError } from "../observability/index.js";
import type {
  ChatResponseErrorContext,
  ChatResponseErrorReporter,
  IncomingAttachment,
  RetryOptions,
  ResolveStopTargetInput,
  SavedAttachments,
} from "./types.js";
import { errorMessage } from "../unknown-values.js";

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
      log.logWarning(`${this.name} intake error`, errorMessage(error));
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
      log.logWarning(`${this.name ? this.name + " " : ""}queue error`, errorMessage(err));
    }
    this.processing = false;
    if (this.queue.length > 0) {
      this.processNext();
      return;
    }
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

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

export function appendChannelLog(office: Office, entry: object): void {
  office.ensure();
  appendFileSync(office.logPath, `${JSON.stringify(entry)}\n`);
}

export async function saveIncomingAttachments(
  office: Office,
  items: readonly IncomingAttachment[],
): Promise<SavedAttachments> {
  if (items.length === 0) return { saved: [], failed: [] };
  office.ensure();
  await mkdir(office.attachmentsDir, { recursive: true });

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
    threadTs: threadTs || undefined,
    user: "bot",
    text,
    attachments: [],
    isMessagingBot: true,
    ...extraFields,
  });
}

export function resolveStopTarget(input: ResolveStopTargetInput): string | null {
  const { handler, address, sessionKey } = input;

  if (sessionKey && handler.isRunning(address, sessionKey)) return sessionKey;
  if (handler.isRunning(address, address.conversationId)) return address.conversationId;
  return null;
}

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

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export class AttachmentRejectedError extends Error {}

function attachmentLimitError(maxBytes: number): AttachmentRejectedError {
  return new AttachmentRejectedError(`exceeds the ${maxBytes}-byte attachment limit`);
}

export async function writeResponseToFile(
  response: Response,
  destPath: string,
  maxBytes: number = MAX_ATTACHMENT_BYTES,
): Promise<void> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw attachmentLimitError(maxBytes);
  }
  await mkdir(dirname(destPath), { recursive: true });
  if (!response.body) {
    await pipeline(Readable.from([]), createWriteStream(destPath));
    return;
  }
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? attachmentLimitError(maxBytes) : null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      limit,
      createWriteStream(destPath),
    );
  } catch (error) {
    await rm(destPath, { force: true });
    throw error;
  }
}

export async function downloadUrlToFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  await writeResponseToFile(response, destPath);
}

const SHORT_NAME_TO_UNICODE_EMOJI: Record<string, string> = {
  saluting_face: "\u{1FAE1}",
  eyes: "\u{1F440}",
  white_check_mark: "\u{2705}",
  "+1": "\u{1F44D}",
  thumbsup: "\u{1F44D}",
  "-1": "\u{1F44E}",
  thumbsdown: "\u{1F44E}",
  heart: "\u{2764}",
  tada: "\u{1F389}",
  rocket: "\u{1F680}",
};

export function shortNameToUnicodeEmoji(emoji: string): string {
  const name = emoji.replace(/^:|:$/g, "");
  return SHORT_NAME_TO_UNICODE_EMOJI[name] ?? emoji;
}
