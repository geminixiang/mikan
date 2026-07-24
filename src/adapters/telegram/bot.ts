import { readFileSync } from "fs";
import { basename, join } from "path";
import { Bot as GrammyMessagingBot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type {
  MessagingBot,
  ConversationEvent,
  MessagingEventHandler,
  ConversationKind,
  MessagingInfo,
} from "../../adapter.js";
import type { TelegramEvent } from "./types.js";
import * as log from "../../log.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  downloadUrlToFile,
  withRetry,
} from "../shared.js";
import { telegramCommandMenu } from "../../commands/manifest.js";
import { processMessageIntake } from "../intake.js";
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

export type { TelegramEvent } from "./types.js";

interface MessageContext {
  msg: Message;
  text: string;
  chatId: string;
  chatType: string;
  conversationKind: ConversationKind;
  userId: string;
  userName: string;
  msgId: string;
  threadTs: string | undefined;
  sessionKey: string;
}

// ============================================================================
// TelegramMessagingBot
// ============================================================================

function isTelegramHtmlParseError(message: string): boolean {
  return message.includes("can't parse entities");
}

export class TelegramMessagingBot implements MessagingBot {
  private client: GrammyMessagingBot;
  private handler: MessagingEventHandler;
  private botToken: string;
  private workingDir: string;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private queues = new Map<string, MessagingEventQueue>();
  private startupTime: number = 0;

  constructor(handler: MessagingEventHandler, config: { token: string; workingDir: string }) {
    this.handler = handler;
    this.botToken = config.token;
    this.workingDir = config.workingDir;
    this.client = new GrammyMessagingBot(config.token);
    this.client.catch((err) => {
      log.logWarning("Telegram error", err instanceof Error ? err.message : String(err));
    });
  }

  // ==========================================================================
  // Public API (implements MessagingBot)
  // ==========================================================================

  async start(): Promise<void> {
    const me = await this.client.api.getMe();
    this.botUserId = String(me.id);
    this.botUsername = me.username ?? null;
    this.startupTime = Date.now();

    // Menu registration derives from the command manifest; routing is
    // separate (native handlers below + intake/dispatch for the rest).
    await this.client.api.setMyCommands(telegramCommandMenu());

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

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    // Telegram reactions are set via setMessageReaction with a Unicode emoji.
    // Short names (Slack style) won't resolve; callers should pass an emoji.
    const name = emoji.replace(/^:|:$/g, "");
    await telegramRetry(async () => {
      await this.client.api.setMessageReaction(parseInt(channel), parseInt(messageTs), [
        { type: "emoji", emoji: name as never },
      ]);
    });
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

  enqueueEvent(event: ConversationEvent): boolean {
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
      const context = createTelegramAdapters(event as TelegramEvent, this);
      return this.handler.handleEvent(event, this, context);
    });
    return true;
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "telegram",
      trustModel: "membership",
      formattingGuide:
        '## Telegram Formatting (HTML mode)\nBold: <b>text</b>, Italic: <i>text</i>, Code: <code>code</code>, Pre: <pre>code</pre>\nLinks: <a href="url">text</a>\nDo NOT use Markdown asterisks or backtick syntax.\nDo NOT use <table> tags — they are unsupported. Use <pre> with ASCII art for tables instead.',
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
   * Returns format compatible with ConversationMessage: { name: string, localPath: string }[]
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

      // Construct download URL
      const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      // Download the file
      await downloadUrlToFile(downloadUrl, join(fullDir, filename));

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

  private getQueue(channelId: string): MessagingEventQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new MessagingEventQueue("Telegram");
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

  private isAddressedToMessagingBot(text: string, chatType: string): boolean {
    if (chatType === "private") return true;
    if (!this.botUsername) return false;
    return text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`);
  }

  private cleanText(text: string): string {
    if (!this.botUsername) return text.trim();
    return text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
  }

  private setupEventHandlers(): void {
    // --- Slash commands (registered before catch-all so grammY intercepts them) ---
    // `/stop` is deliberately NOT registered here: it is a magic word owned by
    // conversation intake, so the catch-all below must receive it.

    this.client.command("new", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;
      const commandText = this.cleanText(mc.text);
      const event: TelegramEvent = {
        type: "command",
        conversationId: mc.chatId,
        conversationKind: mc.conversationKind,
        ts: mc.msgId,
        thread_ts: mc.threadTs,
        sessionKey: mc.sessionKey,
        user: mc.userId,
        userName: mc.userName,
        text: commandText,
        attachments: [],
      };
      this.logToFile(mc.chatId, {
        date: new Date(mc.msg.date * 1000).toISOString(),
        ts: mc.msgId,
        ...(mc.conversationKind === "shared" && mc.threadTs ? { threadTs: mc.threadTs } : {}),
        user: mc.userId,
        userName: mc.userName,
        text: commandText,
        attachments: [],
        isMessagingBot: false,
      });
      await this.handler.handleEvent(event, this, createTelegramAdapters(event, this));
    });

    this.client.command("sandbox", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;
      // The sandbox handler's grammar accepts /sandbox directly (manifest
      // slash forms), so the user's spelling is logged and dispatched as-is.
      const cleanedText = this.cleanText(mc.text);
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
        isMessagingBot: false,
      });
      const context = createTelegramAdapters(event, this);
      await this.handler.handleEvent(event, this, context);
    });

    // --- Catch-all for regular (non-command) messages ---

    this.client.on("message", async (ctx) => {
      const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
      if (!mc) return;

      const cleanedText = this.cleanText(mc.text);
      const addressedToMessagingBot = this.isAddressedToMessagingBot(mc.text, mc.chatType);
      const isAutoReplyCandidate = mc.chatType !== "private" && !addressedToMessagingBot;

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

      await processMessageIntake({
        eventBase,
        workingDir: this.workingDir,
        isAutoReplyCandidate,
        magicWord: {
          addressed: addressedToMessagingBot || mc.chatType === "private",
          scopeFallback: "always",
        },
        busyPolicy: "reject",
        logEntryBase: {
          date: new Date(mc.msg.date * 1000).toISOString(),
          ts: mc.msgId,
          ...(mc.conversationKind === "shared" && mc.threadTs ? { threadTs: mc.threadTs } : {}),
          user: mc.userId,
          userName: mc.userName,
          text: cleanedText,
          isMessagingBot: false,
        },
        log: (entry) => this.logToFile(mc.chatId, entry),
        processAttachments: () => this.processAttachments(mc.chatId, mc.msg),
        queueKey: mc.sessionKey,
        enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
        handler: this.handler,
        bot: this,
        createContext: (event) => createTelegramAdapters(event, this),
      });
    });
  }
}
