import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { Bot as GrammyBot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type { Bot, BotEvent, BotHandler, PlatformInfo } from "../../adapter.js";
import * as log from "../../log.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import { evaluateAutoReplyPolicy } from "../../trigger.js";
import { formatAlreadyWorking, formatNothingRunning } from "../../platform-messages.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  ChannelQueue,
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
  withRetry,
} from "../shared.js";
import { createTelegramAdapters } from "./context.js";
import { escapeTelegramHtml } from "./html.js";

// grammY surfaces Telegram errors as `GrammyError` with `error_code` mirroring
// the Bot API. 429 is the rate-limit status; the response also includes
// `parameters.retry_after` but exponential backoff is good enough here.
function telegramIsRateLimited(err: Error): boolean {
  return (err as { error_code?: number }).error_code === 429;
}

const telegramRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { isRateLimited: telegramIsRateLimited });

// ============================================================================
// Types
// ============================================================================

export interface TelegramEvent extends BotEvent {
  type: "message" | "command";
  userName?: string;
}

interface MessageContext {
  msg: Message;
  text: string;
  chatId: string;
  chatType: string;
  conversationKind: "direct" | "shared";
  userId: string;
  userName: string;
  msgId: string;
  threadTs: string | undefined;
  sessionKey: string;
}

// ============================================================================
// TelegramBot
// ============================================================================

function isTelegramHtmlParseError(message: string): boolean {
  return message.includes("can't parse entities");
}

export class TelegramBot implements Bot {
  private client: GrammyBot;
  private handler: BotHandler;
  private botToken: string;
  private workingDir: string;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private queues = new Map<string, ChannelQueue>();
  private startupTime: number = 0;

  constructor(handler: BotHandler, config: { token: string; workingDir: string }) {
    this.handler = handler;
    this.botToken = config.token;
    this.workingDir = config.workingDir;
    this.client = new GrammyBot(config.token);
    this.client.catch((err) => {
      log.logWarning("Telegram error", err instanceof Error ? err.message : String(err));
    });
  }

  // ==========================================================================
  // Public API (implements Bot)
  // ==========================================================================

  async start(): Promise<void> {
    const me = await this.client.api.getMe();
    this.botUserId = String(me.id);
    this.botUsername = me.username ?? null;
    this.startupTime = Date.now();

    await this.client.api.setMyCommands([
      { command: "login", description: "Store credentials in your private vault" },
      { command: "session", description: "Open the current session in the web viewer" },
      { command: "model", description: "Switch this conversation's LLM model" },
      { command: "sandbox", description: "Show or boost sandbox limits" },
      { command: "stop", description: "Stop ongoing conversation" },
      { command: "new", description: "Reset conversation history and start fresh" },
    ]);

    this.setupEventHandlers();

    // Start polling in background (bot.start() runs indefinitely)
    this.client.start().catch((err) => {
      log.logWarning("Telegram polling error", err instanceof Error ? err.message : String(err));
    });

    log.logConnected("Telegram");
    log.logInfo(`Telegram bot started as @${this.botUsername ?? this.botUserId}`);
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const result = await this.postMessageRaw(parseInt(channel), text);
    return String(result);
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    return telegramRetry(async () => {
      try {
        await this.client.api.editMessageText(parseInt(channel), parseInt(ts), text, {
          parse_mode: "HTML",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("message is not modified")) {
          return;
        }
        if (!isTelegramHtmlParseError(msg)) {
          throw err;
        }
        await this.client.api.editMessageText(
          parseInt(channel),
          parseInt(ts),
          escapeTelegramHtml(text),
          {
            parse_mode: "HTML",
          },
        );
      }
    });
  }

  enqueueEvent(event: BotEvent): boolean {
    const conversationId = event.conversationId;
    const queue = this.getQueue(conversationId);
    if (queue.size() >= 5) {
      log.logWarning(
        `Event queue full for ${conversationId}, discarding: ${event.text.substring(0, 50)}`,
      );
      return false;
    }
    log.logInfo(`Enqueueing event for ${conversationId}: ${event.text.substring(0, 50)}`);
    queue.enqueue(() => {
      const adapters = createTelegramAdapters(event as TelegramEvent, this);
      return this.handler.handleEvent(event, this, adapters);
    });
    return true;
  }

  getPlatformInfo(): PlatformInfo {
    return {
      name: "telegram",
      formattingGuide:
        '## Telegram Formatting (HTML mode)\nBold: <b>text</b>, Italic: <i>text</i>, Code: <code>code</code>, Pre: <pre>code</pre>\nLinks: <a href="url">text</a>',
      channels: [],
      users: [],
    };
  }

  // ==========================================================================
  // Internal helpers (used by context.ts)
  // ==========================================================================

  async postMessageRaw(chatId: number, text: string): Promise<number> {
    return telegramRetry(async () => {
      try {
        const result = await this.client.api.sendMessage(chatId, text, { parse_mode: "HTML" });
        return result.message_id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isTelegramHtmlParseError(msg)) {
          throw err;
        }
        const result = await this.client.api.sendMessage(chatId, escapeTelegramHtml(text), {
          parse_mode: "HTML",
        });
        return result.message_id;
      }
    });
  }

  async postPlainMessage(chatId: number, text: string): Promise<void> {
    return telegramRetry(async () => {
      await this.client.api.sendMessage(chatId, text);
    });
  }

  async postReply(chatId: number, replyToMessageId: number, text: string): Promise<number> {
    return telegramRetry(async () => {
      try {
        const result = await this.client.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_parameters: { message_id: replyToMessageId },
        });
        return result.message_id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isTelegramHtmlParseError(msg)) {
          throw err;
        }
        const result = await this.client.api.sendMessage(chatId, escapeTelegramHtml(text), {
          parse_mode: "HTML",
          reply_parameters: { message_id: replyToMessageId },
        });
        return result.message_id;
      }
    });
  }

  async deleteMessageRaw(chatId: number, messageId: number): Promise<void> {
    await this.client.api.deleteMessage(chatId, messageId);
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.client.api.sendChatAction(chatId, "typing");
  }

  async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
    return telegramRetry(async () => {
      const fileName = title ?? basename(filePath);
      const fileContent = readFileSync(filePath);
      await this.client.api.sendDocument(parseInt(channel), new InputFile(fileContent, fileName));
    });
  }

  logToFile(channel: string, entry: object): void {
    appendChannelLog(this.workingDir, channel, entry);
  }

  logBotResponse(channel: string, text: string, ts: string): void {
    appendBotResponseLog(this.workingDir, channel, text, ts);
  }

  /**
   * Process attachments from a Telegram message
   * Downloads files before returning metadata so the agent can read them immediately
   * Returns format compatible with ChatMessage: { name: string, localPath: string }[]
   */
  async processAttachments(
    chatId: string,
    message: Message,
  ): Promise<{ name: string; localPath: string }[]> {
    const downloads: Array<Promise<{ name: string; localPath: string } | null>> = [];

    // Handle photos (take the largest size for best quality)
    if (message.photo && message.photo.length > 0) {
      const photos = message.photo;
      const photo = photos[photos.length - 1]; // Largest photo
      const fileId = photo.file_id;

      downloads.push(this.processTelegramFile(chatId, fileId, `photo_${message.message_id}.jpg`));
    }

    // Handle documents
    if (message.document) {
      const doc = message.document;
      const fileId = doc.file_id;
      const fileName = doc.file_name ?? `document_${message.message_id}`;

      downloads.push(this.processTelegramFile(chatId, fileId, fileName));
    }

    const attachments = await Promise.all(downloads);
    return attachments.filter(
      (attachment): attachment is { name: string; localPath: string } => attachment !== null,
    );
  }

  /**
   * Download a file from Telegram and return attachment metadata
   */
  private async processTelegramFile(
    chatId: string,
    fileId: string,
    originalName: string,
  ): Promise<{ name: string; localPath: string } | null> {
    try {
      // Get file info from Telegram
      const file = await this.client.api.getFile(fileId);
      if (!file.file_path) {
        log.logWarning("Telegram file has no path", fileId);
        return null;
      }

      // Generate local filename
      const ts = Date.now();
      const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${ts}_${sanitizedName}`;
      const localPath = `${chatId}/attachments/${filename}`;
      const fullDir = join(this.workingDir, chatId, "attachments");

      mkdirSync(fullDir, { recursive: true });

      // Construct download URL
      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      // Download the file
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      writeFileSync(join(fullDir, filename), Buffer.from(buffer));

      return {
        name: originalName,
        localPath: localPath,
      };
    } catch (err) {
      log.logWarning(`Failed to process Telegram file`, `${originalName}: ${err}`);
      return null;
    }
  }

  // ==========================================================================
  // Private - Event Handlers
  // ==========================================================================

  private getQueue(channelId: string): ChannelQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new ChannelQueue("Telegram");
      this.queues.set(channelId, queue);
    }
    return queue;
  }

  private extractMessageContext(msg: Message): MessageContext | null {
    if (!msg) return null;
    if (msg.date * 1000 < this.startupTime) return null;
    if (msg.from?.is_bot) return null;

    const text = msg.text ?? msg.caption ?? "";
    if (!text && !msg.document && !msg.photo) return null;

    const chatId = String(msg.chat.id);
    const chatType = msg.chat.type;
    const userId = String(msg.from?.id ?? "unknown");
    const userName = msg.from?.username ?? msg.from?.first_name ?? userId;
    const msgId = String(msg.message_id);
    const replyToId = msg.reply_to_message?.message_id;
    const threadTs = replyToId ? String(replyToId) : undefined;
    const conversationKind = chatType === "private" ? "direct" : "shared";

    const sessionKey = resolveChatSessionKey({
      conversationId: chatId,
      conversationKind,
      messageId: msgId,
      threadTs,
    });

    return {
      msg,
      text,
      chatId,
      chatType,
      conversationKind,
      userId,
      userName,
      msgId,
      threadTs,
      sessionKey,
    };
  }

  private isAddressedToBot(text: string, chatType: string): boolean {
    if (chatType === "private") return true;
    if (!this.botUsername) return false;
    return text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`);
  }

  private cleanText(text: string): string {
    if (!this.botUsername) return text.trim();
    return text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
  }

  private isStopText(text: string): boolean {
    return /^\/?stop(?:@\w+)?$/i.test(text.trim());
  }

  private resolveStopTarget(mc: MessageContext): string | null {
    const directTarget = resolveStopTarget({
      handler: this.handler,
      conversationId: mc.chatId,
      sessionKey: mc.sessionKey,
    });
    if (directTarget) return directTarget;
    return resolveOnlyScopedStopTarget(this.handler, mc.chatId);
  }

  private setupEventHandlers(): void {
    // --- Slash commands (registered before catch-all so grammY intercepts them) ---

    this.client.command("stop", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;
      const stopTarget = this.resolveStopTarget(mc);
      if (stopTarget) {
        await this.handler.handleStop(stopTarget, mc.chatId, this);
      } else {
        await this.postMessage(mc.chatId, formatNothingRunning("telegram"));
      }
    });

    this.client.command("new", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;
      await this.handler.handleNewCommand(mc.sessionKey, mc.chatId, this);
    });

    this.client.command("sandbox", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;
      const cleanedText = this.cleanText(mc.text).replace(/^\/sandbox(?:@\w+)?/i, "/pi-sandbox");
      const event: TelegramEvent = {
        type: "command",
        conversationId: mc.chatId,
        conversationKind: mc.conversationKind,
        ts: mc.msgId,
        thread_ts: mc.threadTs,
        sessionKey: mc.sessionKey,
        user: mc.userId,
        userName: mc.userName,
        text: cleanedText,
        attachments: [],
      };
      this.logToFile(mc.chatId, {
        date: new Date(mc.msg.date * 1000).toISOString(),
        ts: mc.msgId,
        ...(mc.conversationKind === "shared" && mc.threadTs ? { threadTs: mc.threadTs } : {}),
        user: mc.userId,
        userName: mc.userName,
        text: cleanedText,
        attachments: [],
        isBot: false,
      });
      const adapters = createTelegramAdapters(event, this);
      await this.handler.handleEvent(event, this, adapters);
    });

    // --- Catch-all for regular (non-command) messages ---

    this.client.on("message", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;

      const cleanedText = this.cleanText(mc.text);
      const addressedToBot = this.isAddressedToBot(mc.text, mc.chatType);

      if (this.isStopText(cleanedText)) {
        this.logToFile(mc.chatId, {
          date: new Date(mc.msg.date * 1000).toISOString(),
          ts: mc.msgId,
          user: mc.userId,
          userName: mc.userName,
          text: cleanedText,
          attachments: [],
          isBot: false,
        });

        const stopTarget = this.resolveStopTarget(mc);
        if (stopTarget) {
          await this.handler.handleStop(stopTarget, mc.chatId, this);
        } else if (addressedToBot || mc.chatType === "private") {
          await this.postMessage(mc.chatId, formatNothingRunning("telegram"));
        }
        return;
      }

      const isAutoReplyCandidate = mc.chatType !== "private" && !addressedToBot;

      const eventBase: TelegramEvent = {
        type: "message",
        conversationId: mc.chatId,
        conversationKind: mc.conversationKind,
        ts: mc.msgId,
        thread_ts: mc.threadTs,
        sessionKey: mc.sessionKey,
        user: mc.userId,
        userName: mc.userName,
        text: cleanedText,
      };

      const triggerResult = isAutoReplyCandidate
        ? await evaluateAutoReplyPolicy({ event: eventBase, workingDir: this.workingDir })
        : ({ trigger: true, reason: "addressed" } as const);

      const logEntryBase = {
        date: new Date(mc.msg.date * 1000).toISOString(),
        ts: mc.msgId,
        ...(mc.conversationKind === "shared" && mc.threadTs ? { threadTs: mc.threadTs } : {}),
        user: mc.userId,
        userName: mc.userName,
        text: cleanedText,
        isBot: false,
      };

      if (!triggerResult.trigger) {
        this.logToFile(mc.chatId, { ...logEntryBase, attachments: [] });
        return;
      }

      const processedAttachments = await this.processAttachments(mc.chatId, mc.msg);
      const event: TelegramEvent = { ...eventBase, attachments: processedAttachments };

      this.logToFile(mc.chatId, { ...logEntryBase, attachments: processedAttachments });

      if (this.handler.isRunning(mc.sessionKey)) {
        await this.postMessage(mc.chatId, formatAlreadyWorking("telegram", "/stop"));
      } else {
        this.getQueue(mc.sessionKey).enqueue(() => {
          const adapters = createTelegramAdapters(event, this);
          return this.handler.handleEvent(event, this, adapters);
        });
      }
    });
  }
}
