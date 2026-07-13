import {
  ApplicationCommandOptionType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type Collection,
  type Message,
  type Attachment,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import { readFileSync } from "fs";
import { basename, join } from "path";

import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  ConversationMessage,
  ConversationResponder,
  ChatToolResult,
  MessagingInfo,
} from "../../adapter.js";
import type { DiscordEvent } from "./types.js";
import * as log from "../../log.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import { formatNothingRunning } from "../../platform-messages.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  downloadUrlToFile,
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
  withRetry,
} from "../shared.js";
import { processMessageIntake } from "../intake.js";
import { createDiscordAdapters } from "./context.js";

// discord.js: DiscordAPIError exposes `.status` (HTTP status) and a `.code`.
// RateLimitError fires when the internal queue gives up. MessagingBoth should retry.
function discordIsRateLimited(err: Error): boolean {
  if ((err as { status?: number }).status === 429) return true;
  if ((err as { httpStatus?: number }).httpStatus === 429) return true;
  if (err.name === "RateLimitError") return true;
  return false;
}

const discordRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { isRateLimited: discordIsRateLimited });

// ============================================================================
// Types
// ============================================================================

export type { DiscordEvent } from "./types.js";

// ============================================================================
// DiscordMessagingBot
// ============================================================================

export class DiscordMessagingBot implements MessagingBot {
  private client: Client;
  private handler: MessagingEventHandler;
  private token: string;
  private workingDir: string;
  private botUserId: string | null = null;
  private queues = new Map<string, MessagingEventQueue>();
  private startupTime: number = 0;
  private channels = new Map<string, { id: string; name: string }>();
  private users = new Map<string, { id: string; userName: string; displayName: string }>();

  constructor(handler: MessagingEventHandler, config: { token: string; workingDir: string }) {
    this.handler = handler;
    this.token = config.token;
    this.workingDir = config.workingDir;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  // ==========================================================================
  // Public API (implements MessagingBot)
  // ==========================================================================

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, async (readyClient) => {
        this.botUserId = readyClient.user.id;
        this.startupTime = Date.now();
        log.logConnected("Discord");
        log.logInfo(`Discord bot started as ${readyClient.user.tag}`);
        this.loadCachedGuildData();
        this.setupEventHandlers();
        try {
          await readyClient.application.commands.set([
            {
              name: "login",
              description: "Store credentials in your private vault",
            },
            {
              name: "session",
              description: "Open the current session in the web viewer",
            },
            {
              name: "new",
              description: "Reset conversation history and start fresh",
            },
            {
              name: "stop",
              description: "Stop the current conversation",
            },
            {
              name: "model",
              description: "Switch this conversation's LLM model",
              options: [
                {
                  name: "model",
                  description: "provider/model[:thinking], e.g. anthropic/claude-sonnet-4-6:off",
                  type: ApplicationCommandOptionType.String,
                  required: false,
                },
              ],
            },
            {
              name: "sandbox",
              description: "Show or temporarily boost this conversation's sandbox limits",
              options: [
                {
                  name: "action",
                  description: "Use 'boost' to temporarily apply the configured boost limits",
                  type: ApplicationCommandOptionType.String,
                  required: false,
                },
              ],
            },
          ]);
        } catch (err) {
          log.logWarning(
            "Failed to register Discord slash commands",
            err instanceof Error ? err.message : String(err),
          );
        }
        resolve();
      });
      this.client.once(Events.Error, reject);
      this.client.login(this.token).catch(reject);
    });
  }

  async postMessage(channel: string, text: string): Promise<string> {
    return discordRetry(async () => {
      const ch = await this.fetchTextChannel(channel);
      const msg = await ch.send(text);
      return msg.id;
    });
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.updateMessageRaw(channel, ts, text);
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    // Discord uses Unicode emoji directly (e.g. "👀"); accept a bare name too
    // but Slack-style short names won't resolve, so pass through as-is.
    await discordRetry(async () => {
      const ch = await this.fetchTextChannel(channel);
      const msg = await ch.messages.fetch(messageTs);
      await msg.react(emoji.replace(/^:|:$/g, ""));
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
      const context = createDiscordAdapters(event as DiscordEvent, this);
      return this.handler.handleEvent(event, this, context);
    });
    return true;
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "discord",
      trustModel: "membership",
      formattingGuide:
        "## Discord Formatting (Markdown)\nBold: **text**, Italic: *text*, Code: `code`, Block: ```language\ncode```\nLinks: [text](url)",
      channels: this.getAllChannels(),
      users: this.getAllUsers(),
      diagnostics: {
        showUsageSummary: false,
      },
    };
  }

  // ==========================================================================
  // Internal helpers (used by context.ts)
  // ==========================================================================

  async updateMessageRaw(channelId: string, messageId: string, text: string): Promise<void> {
    return discordRetry(async () => {
      const ch = await this.fetchTextChannel(channelId);
      const msg = await ch.messages.fetch(messageId);
      await msg.edit(text);
    });
  }

  async postReply(channelId: string, replyToId: string, text: string): Promise<string> {
    return discordRetry(async () => {
      const ch = await this.fetchTextChannel(channelId);
      const replyTarget = await ch.messages.fetch(replyToId);
      const sent = await replyTarget.reply(text);
      return sent.id;
    });
  }

  async postInThread(channelId: string, threadOrMessageId: string, text: string): Promise<string> {
    // Try as a thread channel first, then fall back to posting in the channel
    try {
      const thread = await this.client.channels.fetch(threadOrMessageId);
      if (thread && (thread.isThread() || thread.isTextBased())) {
        return discordRetry(async () => {
          const msg = await (thread as ThreadChannel).send(text);
          return msg.id;
        });
      }
    } catch {
      // Not a thread channel, treat as message ID for reply
    }
    return this.postReply(channelId, threadOrMessageId, text);
  }

  async deleteMessageRaw(channelId: string, messageId: string): Promise<void> {
    try {
      const ch = await this.fetchTextChannel(channelId);
      const msg = await ch.messages.fetch(messageId);
      await msg.delete();
    } catch {
      // Ignore if already deleted
    }
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const ch = await this.fetchTextChannel(channelId);
      await ch.sendTyping();
    } catch {
      // Non-fatal
    }
  }

  async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
    return discordRetry(async () => {
      const ch = await this.fetchTextChannel(channelId);
      const fileName = title ?? basename(filePath);
      const fileContent = readFileSync(filePath);
      await ch.send({ files: [{ attachment: fileContent, name: fileName }] });
    });
  }

  async sendDirectMessage(userId: string, text: string): Promise<string> {
    return discordRetry(async () => {
      const user = await this.client.users.fetch(userId);
      const msg = await user.send(text);
      return msg.id;
    });
  }

  async postPrivate(_conversationId: string, userId: string, text: string): Promise<void> {
    await this.sendDirectMessage(userId, text);
  }

  getAllChannels(): { id: string; name: string }[] {
    return Array.from(this.channels.values());
  }

  getAllUsers(): { id: string; userName: string; displayName: string }[] {
    return Array.from(this.users.values());
  }

  logToFile(channelId: string, entry: object): void {
    appendChannelLog(this.workingDir, channelId, entry);
  }

  logBotResponse(channelId: string, text: string, ts: string): void {
    appendBotResponseLog(this.workingDir, channelId, text, ts);
  }

  /**
   * Process attachments from a Discord message.
   * Downloads files before returning so the agent can read them immediately.
   */
  async processAttachments(
    channelId: string,
    attachments: Collection<string, Attachment>,
    _messageId: string,
  ): Promise<{ name: string; localPath: string }[]> {
    const downloads: Array<Promise<{ name: string; localPath: string } | null>> = [];

    // Discord attachments Collection - iterate over values
    for (const attachment of attachments.values()) {
      if (!attachment.name) {
        log.logWarning("Discord attachment missing name, skipping", attachment.url);
        continue;
      }

      const ts = Date.now();
      const sanitizedName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${ts}_${sanitizedName}`;
      const localPath = `${channelId}/attachments/${filename}`;
      const fullDir = join(this.workingDir, channelId, "attachments");
      const result = {
        name: attachment.name,
        localPath,
      };

      downloads.push(
        this.downloadAttachment(fullDir, filename, attachment.url)
          .then(() => result)
          .catch((err) => {
            log.logWarning(`Failed to download Discord attachment`, `${filename}: ${err}`);
            return null;
          }),
      );
    }

    const results = await Promise.all(downloads);
    return results.filter(
      (attachment): attachment is { name: string; localPath: string } => attachment !== null,
    );
  }

  /**
   * Download an attachment from URL to local file
   */
  private async downloadAttachment(dir: string, filename: string, url: string): Promise<void> {
    try {
      await downloadUrlToFile(url, join(dir, filename));
    } catch (err) {
      throw new Error(`Download failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }

  // ==========================================================================
  // Private - Event Handlers
  // ==========================================================================

  private getQueue(channelId: string): MessagingEventQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new MessagingEventQueue("Discord");
      this.queues.set(channelId, queue);
    }
    return queue;
  }

  private resolveStopTarget(channelId: string, sessionKey: string): string | null {
    const directTarget = resolveStopTarget({
      handler: this.handler,
      conversationId: channelId,
      sessionKey,
    });
    if (directTarget) return directTarget;
    if (sessionKey !== channelId) return null;
    return resolveOnlyScopedStopTarget(this.handler, channelId);
  }

  private loadCachedGuildData(): void {
    for (const guild of this.client.guilds.cache.values()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.isTextBased() && "name" in channel) {
          this.channels.set(channel.id, { id: channel.id, name: channel.name ?? channel.id });
        }
      }
      for (const member of guild.members.cache.values()) {
        this.users.set(member.id, {
          id: member.id,
          userName: member.user.username,
          displayName: member.displayName,
        });
      }
    }
  }

  private stripMessagingBotMention(text: string): string {
    if (!this.botUserId) return text;
    return text.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
  }

  private resolveConversationContext(input: {
    channelId: string;
    inGuild: boolean;
    isThread: boolean;
    parentChannelId?: string | null;
    referencedMsgId?: string;
  }): { conversationId: string; threadTs?: string } {
    if (!input.inGuild) {
      return {
        conversationId: input.channelId,
        threadTs: input.referencedMsgId,
      };
    }

    if (input.isThread) {
      return {
        conversationId: input.parentChannelId ?? input.channelId,
        threadTs: input.channelId,
      };
    }

    return {
      conversationId: input.channelId,
      threadTs: input.referencedMsgId,
    };
  }

  private createSlashCommandAdapters(
    interaction: ChatInputCommandInteraction,
    commandText: string,
    sessionKey: string,
    conversationId: string,
  ): ConversationContext {
    const isDM = !interaction.inGuild();
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const platform = this.getMessagingInfo();
    const shouldUseEphemeral = !isDM;

    const message: ConversationMessage = {
      id: interaction.id,
      sessionKey,
      conversationKind: isDM ? "direct" : "shared",
      userId,
      userName,
      text: commandText,
      attachments: [],
    };

    const respondPrivately = async (text: string, replace = false): Promise<void> => {
      if (interaction.replied || interaction.deferred) {
        if (replace) {
          await interaction.editReply({ content: text });
        } else {
          await interaction.followUp({ content: text, ephemeral: shouldUseEphemeral });
        }
        return;
      }

      await interaction.reply({ content: text, ephemeral: shouldUseEphemeral });
    };

    const responder: ConversationResponder = {
      respond: async (text: string) => {
        await respondPrivately(text);
      },
      replaceResponse: async (text: string) => {
        await respondPrivately(text, true);
      },
      respondDiagnostic: async (text: string) => {
        await respondPrivately(text);
      },
      respondToolResult: async (result: ChatToolResult) => {
        const duration = (result.durationMs / 1000).toFixed(1);
        const formatted = `${result.isError ? "Error" : "Done"} ${result.toolName} (${duration}s)\n${result.result}`;
        await respondPrivately(formatted);
      },
      setTyping: async () => {},
      setWorking: async () => {},
      uploadFile: async (filePath: string, title?: string) => {
        await this.uploadFile(conversationId, filePath, title);
      },
      deleteResponse: async () => {},
    };

    return { message, responder, platform };
  }

  private setupEventHandlers(): void {
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (
        interaction.commandName !== "login" &&
        interaction.commandName !== "session" &&
        interaction.commandName !== "new" &&
        interaction.commandName !== "stop" &&
        interaction.commandName !== "model" &&
        interaction.commandName !== "sandbox"
      ) {
        return;
      }

      const isDM = !interaction.inGuild();
      const { conversationId, threadTs } = this.resolveConversationContext({
        channelId: interaction.channelId,
        inGuild: interaction.inGuild(),
        isThread: interaction.channel?.isThread() ?? false,
        parentChannelId:
          interaction.channel && "parentId" in interaction.channel
            ? interaction.channel.parentId
            : null,
      });
      const sessionKey = resolveChatSessionKey({
        conversationId,
        conversationKind: isDM ? "direct" : "shared",
        messageId: interaction.id,
        persistentTopLevel: true,
        threadTs,
      });
      const modelOption =
        interaction.commandName === "model"
          ? interaction.options.getString("model")?.trim()
          : undefined;
      const sandboxAction =
        interaction.commandName === "sandbox"
          ? interaction.options.getString("action")?.trim()
          : undefined;
      const commandArg = modelOption ?? sandboxAction;
      const commandText = commandArg
        ? `/${interaction.commandName} ${commandArg}`
        : `/${interaction.commandName}`;

      this.logToFile(conversationId, {
        date: new Date(interaction.createdTimestamp).toISOString(),
        ts: interaction.id,
        ...(threadTs ? { threadTs } : {}),
        user: interaction.user.id,
        userName: interaction.user.username,
        text: commandText,
        attachments: [],
        isMessagingBot: false,
      });

      const context = this.createSlashCommandAdapters(
        interaction,
        commandText,
        sessionKey,
        conversationId,
      );
      try {
        if (interaction.commandName === "new") {
          await this.handler.handleNewCommand(sessionKey, conversationId, this);
          await context.responder.respond("Started a new conversation.");
          return;
        }

        if (interaction.commandName === "stop") {
          const stopTarget = this.resolveStopTarget(conversationId, sessionKey);
          if (stopTarget) {
            await this.handler.handleStop(stopTarget, conversationId, this);
            await context.responder.respond("Stopped the current conversation.");
          } else {
            await context.responder.respond(formatNothingRunning("discord"));
          }
          return;
        }

        const event: ConversationEvent = {
          type: "dm",
          conversationId,
          conversationKind: isDM ? "direct" : "shared",
          ts: interaction.id,
          thread_ts: threadTs,
          sessionKey,
          user: interaction.user.id,
          text: commandText,
          attachments: [],
        };

        await this.handler.handleEvent(event, this, context);
      } catch (err) {
        log.logWarning(
          "Discord slash command error",
          err instanceof Error ? err.message : String(err),
        );
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: `${interaction.commandName} command failed. Please try again later.`,
            ephemeral: !isDM,
          });
        }
      }
    });

    this.client.on(Events.MessageCreate, async (msg: Message) => {
      // Skip messages from before startup
      if (msg.createdTimestamp < this.startupTime) return;
      // Skip bot messages
      if (msg.author.bot) return;
      const isDM = msg.channel.type === 1; // ChannelType.DM = 1
      const isInThread = msg.channel.isThread();
      const referencedMsgId = msg.reference?.messageId;
      const isThreadReply = isInThread || !!referencedMsgId;
      const isMentioned = msg.mentions.users.has(this.botUserId ?? "");
      const isAutoReplyCandidate = !isDM && !isMentioned && !isThreadReply;

      const { conversationId, threadTs } = this.resolveConversationContext({
        channelId: msg.channelId,
        inGuild: !isDM,
        isThread: isInThread,
        parentChannelId: "parentId" in msg.channel ? msg.channel.parentId : null,
        referencedMsgId,
      });
      const userId = msg.author.id;
      const userName = msg.author.username;
      const msgId = msg.id;

      // Track user
      this.users.set(userId, {
        id: userId,
        userName,
        displayName: msg.member?.displayName ?? userName,
      });

      // Track channel
      if (!this.channels.has(conversationId) && "name" in msg.channel) {
        const ch = msg.channel as TextChannel | NewsChannel;
        this.channels.set(conversationId, { id: conversationId, name: ch.name });
      }

      const conversationKind = isDM ? "direct" : "shared";
      const sessionKey = resolveChatSessionKey({
        conversationId,
        conversationKind,
        messageId: msgId,
        persistentTopLevel: true,
        threadTs,
      });

      const cleanedText = this.stripMessagingBotMention(msg.content);

      const eventBase: DiscordEvent = {
        type: isDM ? "dm" : "mention",
        conversationId,
        conversationKind,
        ts: msgId,
        thread_ts: threadTs,
        sessionKey,
        user: userId,
        userName,
        text: cleanedText,
      };

      await processMessageIntake({
        eventBase,
        workingDir: this.workingDir,
        isAutoReplyCandidate,
        magicWord: { addressed: !isAutoReplyCandidate, scopeFallback: "top-level" },
        busyPolicy: "queue",
        logEntryBase: {
          date: msg.createdAt.toISOString(),
          ts: msgId,
          ...(!isDM && threadTs ? { threadTs } : {}),
          user: userId,
          userName,
          text: cleanedText,
          isMessagingBot: false,
        },
        log: (entry) => this.logToFile(conversationId, entry),
        processAttachments: () => this.processAttachments(conversationId, msg.attachments, msgId),
        queueKey: sessionKey,
        enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
        handler: this.handler,
        bot: this,
        createContext: (event) => createDiscordAdapters(event, this),
      });
    });
  }

  private async fetchTextChannel(
    channelId: string,
  ): Promise<TextChannel | DMChannel | NewsChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return ch as TextChannel | DMChannel | NewsChannel | ThreadChannel;
  }
}
