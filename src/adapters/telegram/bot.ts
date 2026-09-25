import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Bot as GrammyMessagingBot, InputFile } from "grammy";
import type { Message } from "grammy/types";
import type {
  ConversationEvent,
  MessagingEventHandler,
  ConversationKind,
  MessagingInfo,
} from "../index.js";
import { createConversationEvent, type MessagingBot } from "../index.js";
import type { TelegramEvent } from "./types.js";
import * as log from "../../log.js";
import { resolveChatSessionKey } from "../../sessions/session-key.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  MessagingIntakeTracker,
  downloadUrlToFile,
  withRetry,
  saveIncomingAttachments,
  shortNameToUnicodeEmoji,
  type IncomingAttachment,
} from "../shared.js";
import { COMMAND_MANIFEST, telegramCommandMenu } from "../commands/manifest.js";
import { processMessageIntake } from "../intake.js";
import { createTelegramAdapters } from "./context.js";
import { createOfficeAddress, type Workspace } from "../../office/index.js";

function telegramIsRateLimited(err: Error): boolean {
  return (err as { error_code?: number }).error_code === 429;
}

const telegramRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { isRateLimited: telegramIsRateLimited });

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

function richMessage(markdown: string): { markdown: string } {
  return { markdown };
}

export class TelegramMessagingBot implements MessagingBot {
  private client: GrammyMessagingBot;
  private handler: MessagingEventHandler;
  private botToken: string;
  private workspace: Workspace;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private stopped = false;
  private queues = new Map<string, MessagingEventQueue>();
  private intake = new MessagingIntakeTracker("Telegram");
  private startupTime: number = 0;

  constructor(handler: MessagingEventHandler, config: { token: string; workspace: Workspace }) {
    this.handler = handler;
    this.botToken = config.token;
    this.workspace = config.workspace;
    this.client = new GrammyMessagingBot(config.token);
    this.client.catch((err) => {
      log.logWarning("Telegram error", err instanceof Error ? err.message : String(err));
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    const me = await this.client.api.getMe();
    this.botUserId = String(me.id);
    this.botUsername = me.username ?? null;
    this.startupTime = Date.now();

    await this.client.api.setMyCommands(telegramCommandMenu());
    if (this.stopped) return;

    this.setupEventHandlers();

    this.client.start().catch((err) => {
      log.logWarning("Telegram polling error", err instanceof Error ? err.message : String(err));
    });

    log.logConnected("Telegram");
    log.logInfo(`Telegram bot started as @${this.botUsername ?? this.botUserId}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.client.stop();
    } finally {
      await this.intake.close();
      await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    }
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const result = await this.postMessageRaw(parseInt(channel), text);
    return String(result);
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    await telegramRetry(async () => {
      await this.client.api.setMessageReaction(parseInt(channel), parseInt(messageTs), [
        { type: "emoji", emoji: shortNameToUnicodeEmoji(emoji) as never },
      ]);
    });
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    return telegramRetry(async () => {
      try {
        await this.client.api.editMessageText(parseInt(channel), parseInt(ts), richMessage(text));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("message is not modified")) return;
        throw err;
      }
    });
  }

  enqueueEvent(event: ConversationEvent): boolean {
    if (this.stopped) return false;
    const conversationId = event.address.conversationId;
    const queue = this.getQueue(conversationId);
    if (queue.size() >= 5) {
      log.logWarning(
        `Event queue full for ${conversationId}, discarding: ${event.text.substring(0, 50)}`,
      );
      return false;
    }
    log.logInfo(`Enqueueing event for ${conversationId}: ${event.text.substring(0, 50)}`);
    return queue.enqueue(() => {
      const context = createTelegramAdapters(event as TelegramEvent, this);
      return this.handler.handleEvent(event, this, context);
    });
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "telegram",
      trustModel: "membership",
      formattingGuide:
        "## Telegram Formatting (Markdown)\nWrite ordinary Markdown — headings, lists, tables, code fences, quotes and links all render natively. Nothing needs converting by hand.",
      channels: [],
      users: [],
    };
  }

  async postMessageRaw(chatId: number, text: string): Promise<number> {
    return telegramRetry(async () => {
      const result = await this.client.api.sendRichMessage(chatId, richMessage(text));
      return result.message_id;
    });
  }

  async postPlainMessage(chatId: number, text: string): Promise<void> {
    return telegramRetry(async () => {
      await this.client.api.sendMessage(chatId, text);
    });
  }

  async postReply(chatId: number, replyToMessageId: number, text: string): Promise<number> {
    return telegramRetry(async () => {
      const result = await this.client.api.sendRichMessage(chatId, richMessage(text), {
        reply_parameters: { message_id: replyToMessageId },
      });
      return result.message_id;
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
    appendChannelLog(this.workspace.office(createOfficeAddress("telegram", channel)), entry);
  }

  logBotResponse(channel: string, text: string, ts: string): void {
    appendBotResponseLog(this.workspace.office(createOfficeAddress("telegram", channel)), text, ts);
  }

  async processAttachments(
    chatId: string,
    message: Message,
  ): Promise<{ name: string; localPath: string }[]> {
    const items: IncomingAttachment[] = [];

    const photo = message.photo?.[message.photo.length - 1];
    if (photo) {
      items.push(this.telegramFileItem(photo.file_id, `photo_${message.message_id}.jpg`));
    }
    if (message.document) {
      const doc = message.document;
      items.push(
        this.telegramFileItem(doc.file_id, doc.file_name ?? `document_${message.message_id}`),
      );
    }

    const office = this.workspace.office(createOfficeAddress("telegram", chatId));
    const { saved, failed } = await saveIncomingAttachments(office, items);
    for (const failure of failed) {
      log.logWarning(`Failed to process Telegram file`, `${failure.name}: ${failure.error}`);
    }
    return saved.map((item) => ({ name: item.original, localPath: item.localPath }));
  }

  private telegramFileItem(fileId: string, name: string): IncomingAttachment {
    return {
      name,
      download: async (destPath) => {
        const file = await this.client.api.getFile(fileId);
        if (!file.file_path) throw new Error(`Telegram file has no path: ${fileId}`);
        await downloadUrlToFile(
          `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`,
          destPath,
        );
      },
    };
  }

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
    for (const entry of COMMAND_MANIFEST) {
      if (!entry.telegramCommand || entry.magicWord) continue;
      this.client.command(entry.name, (ctx) =>
        this.intake.run(async () => {
          const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
          if (!mc) return;
          const commandText = this.cleanText(mc.text);
          const event = createConversationEvent({
            platform: "telegram",
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
          }) as TelegramEvent;
          this.logToFile(mc.chatId, {
            date: new Date(mc.msg.date * 1000).toISOString(),
            ts: mc.msgId,
            threadTs: mc.conversationKind === "shared" && mc.threadTs ? mc.threadTs : undefined,
            user: mc.userId,
            userName: mc.userName,
            text: commandText,
            attachments: [],
            isMessagingBot: false,
          });
          await this.handler.handleEvent(event, this, createTelegramAdapters(event, this));
        }),
      );
    }

    this.client.on("message", (ctx) =>
      this.intake.run(async () => {
        const mc = ctx.message ? this.extractMessageContext(ctx.message) : null;
        if (!mc) return;

        const cleanedText = this.cleanText(mc.text);
        const addressedToMessagingBot = this.isAddressedToMessagingBot(mc.text, mc.chatType);
        const addressed = mc.chatType === "private" || addressedToMessagingBot;

        const eventBase = createConversationEvent({
          platform: "telegram",
          type: "message",
          conversationId: mc.chatId,
          conversationKind: mc.conversationKind,
          ts: mc.msgId,
          thread_ts: mc.threadTs,
          sessionKey: mc.sessionKey,
          user: mc.userId,
          userName: mc.userName,
          text: cleanedText,
        }) as TelegramEvent;

        await processMessageIntake({
          eventBase,
          addressed,
          magicWord: {
            addressed: addressedToMessagingBot || mc.chatType === "private",
            scopeFallback: "always",
          },
          busyPolicy: "reject",
          logEntryBase: {
            date: new Date(mc.msg.date * 1000).toISOString(),
            ts: mc.msgId,
            threadTs: mc.conversationKind === "shared" && mc.threadTs ? mc.threadTs : undefined,
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
      }),
    );
  }
}
