import { SocketModeClient } from "@slack/socket-mode";
import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import type {
  Bot,
  BotAdapters,
  BotEvent,
  BotHandler,
  ChatMessage,
  ChatResponseContext,
  ChatToolResult,
  ConversationKind,
  PlatformInfo,
} from "../../adapter.js";
import type { EventsWatcher } from "../../events.js";
import * as log from "../../log.js";
import type { Attachment, ChannelStore } from "../../store.js";
import { PRODUCT_NAME, formatForceStopped, formatNothingRunning } from "../../ui-copy.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  ChannelQueue,
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
  withRetry,
} from "../shared.js";
import { evaluateAutoReplyPolicy } from "../../trigger.js";
import { createSlackAdapters } from "./context.js";
import {
  hasMaterializedChatSession,
  registerThreadSession,
} from "../../sessions/chat-session-manager.js";
import {
  isSlackThreadSessionKey,
  planSlackAdapterSession,
  planSlackEventAnchorRun,
  resolveSlackSessionKey,
} from "./session.js";
import { reportUserFacingError } from "../../sentry.js";

const SLACK_EVENT_ANCHOR_TEXT = "Working on it...";

// Slack WebClient errors carry either `code: "rate_limited"` (retry-after) or
// the legacy `data.error === "rate_limited"` / 429 status shape.
function slackIsRateLimited(err: Error): boolean {
  if ((err as { code?: unknown }).code === "rate_limited") return true;
  const data = (err as { data?: { error?: string; response?: { status?: number } } }).data;
  return data?.error === "rate_limited" || data?.response?.status === 429;
}

const slackRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { isRateLimited: slackIsRateLimited });

function collectSlackText(value: unknown, parts: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) parts.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSlackText(item, parts);
    return;
  }
  if (typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  for (const key of ["text", "fallback", "title", "value"] as const) {
    collectSlackText(obj[key], parts);
  }
  collectSlackText(obj.fields, parts);
  collectSlackText(obj.elements, parts);
  collectSlackText(obj.blocks, parts);
}

function buildSlackAppMessageText(event: {
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}): string {
  const parts: string[] = [];
  collectSlackText(event.text, parts);
  collectSlackText(event.blocks, parts);
  collectSlackText(event.attachments, parts);
  const deduped = parts.filter((part, index) => parts.indexOf(part) === index);
  return deduped.join("\n");
}

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
  type: "mention" | "dm";
  conversationId: string;
  conversationKind: ConversationKind;
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
  /** Processed attachments with local paths (populated after logUserMessage) */
  attachments?: Attachment[];
  /** Session key passed through to BotEvent so handleEvent uses the correct persistent session */
  sessionKey?: string;
}

export interface SlackUser {
  id: string;
  userName: string;
  displayName: string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot implements Bot {
  private socketClient: SocketModeClient;
  private webClient: WebClient;
  private handler: BotHandler;
  private workingDir: string;
  private store: ChannelStore;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private ownMentionRegex: RegExp | null = null;
  private startupTs: string | null = null; // Messages older than this are just logged, not processed

  private users = new Map<string, SlackUser>();
  private channels = new Map<string, SlackChannel>();
  private queues = new Map<string, ChannelQueue>();
  private eventsWatcher: EventsWatcher | null = null;

  constructor(
    handler: BotHandler,
    config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
  ) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.store = config.store;
    this.socketClient = new SocketModeClient({
      appToken: config.appToken,
      // Default 5s is too tight: brief event-loop stalls (e.g. backfill, sync fs)
      // cause false pong timeouts; 4 in a row makes Slack drop the socket.
      clientPingTimeout: 12_000,
    });
    this.webClient = new WebClient(config.botToken);
  }

  setEventsWatcher(watcher: EventsWatcher): void {
    this.eventsWatcher = watcher;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async start(): Promise<void> {
    const auth = await this.webClient.auth.test();
    this.botUserId = auth.user_id as string;
    this.botId = typeof auth.bot_id === "string" ? auth.bot_id : null;

    await Promise.all([this.fetchUsers(), this.fetchChannels()]);
    log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

    // Record startup time before opening the socket. Slack may replay older events;
    // those should be logged but not processed. Backfill runs in the background up
    // to this timestamp so startup is not blocked by one history call per channel.
    this.startupTs = (Date.now() / 1000).toFixed(6);

    this.setupEventHandlers();
    await this.socketClient.start();

    log.logConnected("Slack");

    void this.backfillAllChannels(this.startupTs).catch((error) => {
      log.logWarning("Slack backfill failed", String(error));
    });
  }

  getUser(userId: string): SlackUser | undefined {
    return this.users.get(userId);
  }

  getChannel(channelId: string): SlackChannel | undefined {
    return this.channels.get(channelId);
  }

  getAllUsers(): SlackUser[] {
    return Array.from(this.users.values());
  }

  getAllChannels(): SlackChannel[] {
    return Array.from(this.channels.values());
  }

  private stripOwnMention(text: string | undefined): string {
    const source = text ?? "";
    if (!this.botUserId) return source.trim();
    if (!this.ownMentionRegex || !this.ownMentionRegex.source.includes(this.botUserId)) {
      this.ownMentionRegex = new RegExp(`<@${this.botUserId}>`, "gi");
    }
    return source.replace(this.ownMentionRegex, "").trim();
  }

  async postMessage(channel: string, text: string): Promise<string> {
    return slackRetry(async () => {
      const result = await this.webClient.chat.postMessage({ channel, text });
      return result.ts as string;
    });
  }

  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    threadTs?: string,
  ): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.chat.postEphemeral({
        channel,
        user,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    });
  }

  async postEphemeralBlocks(
    channel: string,
    user: string,
    text: string,
    blocks: object[],
    threadTs?: string,
  ): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.chat.postEphemeral({
        channel,
        user,
        text,
        blocks: blocks as KnownBlock[],
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    });
  }

  async postMessageBlocks(channel: string, text: string, blocks: object[]): Promise<string> {
    return slackRetry(async () => {
      const result = await this.webClient.chat.postMessage({
        channel,
        text,
        blocks: blocks as KnownBlock[],
      });
      return result.ts as string;
    });
  }

  async postPrivate(conversationId: string, userId: string, text: string): Promise<void> {
    await this.postEphemeral(conversationId, userId, text);
  }

  async postPrivateDiagnostic(
    conversationId: string,
    userId: string,
    text: string,
    options?: { style?: "muted" | "error" },
  ): Promise<void> {
    if (options?.style !== "muted") {
      await this.postPrivate(
        conversationId,
        userId,
        options?.style === "error" ? `_${text}_` : text,
      );
      return;
    }
    const CONTEXT_TEXT_LIMIT = 3000;
    const blockText =
      text.length > CONTEXT_TEXT_LIMIT
        ? text.substring(0, CONTEXT_TEXT_LIMIT - 20) + "\n_(truncated)_"
        : text;
    await this.postEphemeralBlocks(conversationId, userId, text, [
      { type: "context", elements: [{ type: "mrkdwn", text: blockText }] },
    ]);
  }

  async openDirectMessage(userId: string): Promise<string> {
    return slackRetry(async () => {
      const result = await this.webClient.conversations.open({ users: userId });
      const channelId = result.channel?.id;
      if (!channelId) {
        throw new Error(`Failed to open DM for user ${userId}`);
      }
      return channelId;
    });
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.chat.update({ channel, ts, text });
    });
  }

  async deleteMessage(channel: string, ts: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.chat.delete({ channel, ts });
    });
  }

  // ==========================================================================
  // Slack Assistant API (AI assistant experience)
  // ==========================================================================

  /** Set the status for an assistant thread (shows "thinking" state) */
  async setAssistantStatus(channel: string, threadTs: string, status: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.assistant.threads.setStatus({
        channel_id: channel,
        thread_ts: threadTs,
        status,
      });
    });
  }

  async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
    return slackRetry(async () => {
      // Use Block Kit section for long messages to trigger Slack's "Show more" collapsing (~700 chars)
      const SECTION_TEXT_LIMIT = 3000;
      if (text.length > 500) {
        const blockText =
          text.length > SECTION_TEXT_LIMIT
            ? text.substring(0, SECTION_TEXT_LIMIT - 20) + "\n_(truncated)_"
            : text;
        const result = await this.webClient.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text, // full text as notification fallback
          blocks: [{ type: "section", text: { type: "mrkdwn", text: blockText } }],
        });
        return result.ts as string;
      }
      const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
      return result.ts as string;
    });
  }

  async postInThreadBlocks(
    channel: string,
    threadTs: string,
    text: string,
    blocks: object[],
  ): Promise<string> {
    return slackRetry(async () => {
      const result = await this.webClient.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text, // fallback for notifications
        blocks: blocks as KnownBlock[],
      });
      return result.ts as string;
    });
  }

  async uploadFile(
    channel: string,
    filePath: string,
    title?: string,
    threadTs?: string,
  ): Promise<void> {
    return slackRetry(async () => {
      const fileName = title || basename(filePath);
      const fileContent = readFileSync(filePath);
      await this.webClient.files.uploadV2({
        channel_id: channel,
        file: fileContent,
        filename: fileName,
        title: fileName,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      } as Parameters<typeof this.webClient.files.uploadV2>[0]);
    });
  }

  logToFile(channel: string, entry: object): void {
    appendChannelLog(this.workingDir, channel, entry);
  }

  logBotResponse(channel: string, text: string, ts: string, threadTs?: string): void {
    appendBotResponseLog(this.workingDir, channel, text, ts, threadTs);
  }

  getPlatformInfo(): PlatformInfo {
    return {
      name: "slack",
      formattingGuide:
        "## Slack Formatting (mrkdwn, NOT Markdown)\nBold: *text*, Italic: _text_, Code: `code`, Block: ```code```, Links: <url|text>\nDo NOT use **double asterisks** or [markdown](links).",
      channels: this.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
      users: this.getAllUsers().map((u) => ({
        id: u.id,
        userName: u.userName,
        displayName: u.displayName,
      })),
      diagnostics: {
        showUsageSummary: true,
      },
    };
  }

  // ==========================================================================
  // Events Integration
  // ==========================================================================

  /**
   * Enqueue an event for processing. Always queues (no "already working" rejection).
   * Returns true if enqueued, false if queue is full (max 5).
   */
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
    queue.enqueue(async () => {
      let anchorTs: string | undefined;
      if (!event.thread_ts) {
        try {
          anchorTs = await this.postMessage(conversationId, SLACK_EVENT_ANCHOR_TEXT);
        } catch (err) {
          log.logWarning(
            `Failed to post Slack event anchor for ${conversationId}`,
            err instanceof Error ? err.message : String(err),
          );
          reportUserFacingError(err, {
            domain: "events",
            surface: "event_delivery",
            operation: "slack_anchor_post",
            severity: "error",
            platform: "slack",
            context: {
              conversationId,
              conversationKind: event.conversationKind,
              eventTs: event.ts,
              textLength: event.text.length,
            },
          });
          throw err;
        }
      }
      const eventPlan = planSlackEventAnchorRun(event, anchorTs);
      const eventForRun = eventPlan.event;
      if (eventPlan.initialMessageTs && eventForRun.sessionKey) {
        registerThreadSession({
          conversationDir: join(this.workingDir, conversationId),
          sessionKey: eventForRun.sessionKey,
        });
      }

      const runQueueKey = planSlackAdapterSession(eventForRun, {
        initialMessageTs: eventPlan.initialMessageTs,
      }).sessionKey;
      this.getQueue(runQueueKey).enqueue(async () => {
        const slackEvent: SlackEvent = {
          type: eventForRun.type as SlackEvent["type"],
          conversationId,
          conversationKind: eventForRun.conversationKind,
          channel: conversationId,
          ts: eventForRun.ts,
          thread_ts: eventForRun.thread_ts,
          user: eventForRun.user,
          text: eventForRun.text,
          attachments: eventForRun.attachments?.map((attachment) => ({
            original: attachment.name,
            localPath: attachment.localPath,
          })),
          sessionKey: eventForRun.sessionKey,
        };
        const adapters = createSlackAdapters(slackEvent, this, {
          initialMessageTs: eventPlan.initialMessageTs,
        });
        return this.handler.handleEvent(eventForRun, this, adapters);
      });
    });
    return true;
  }

  // ==========================================================================
  // Private - Event Handlers
  // ==========================================================================

  private getQueue(channelId: string): ChannelQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new ChannelQueue("Slack");
      this.queues.set(channelId, queue);
    }
    return queue;
  }

  private resolveQueueKey(conversationId: string, sessionKey: string): string {
    if (!isSlackThreadSessionKey(sessionKey)) return sessionKey;
    if (this.handler.isRunning(sessionKey)) return sessionKey;
    return this.hasKnownThreadSession(conversationId, sessionKey) ? sessionKey : conversationId;
  }

  private hasKnownThreadSession(conversationId: string, sessionKey: string): boolean {
    return hasMaterializedChatSession({
      conversationDir: join(this.workingDir, conversationId),
      sessionKey,
    });
  }

  private shouldTriggerSharedThreadReply(channelId: string, threadTs?: string): boolean {
    if (!threadTs) return false;

    const sessionKey = resolveSlackSessionKey(channelId, threadTs);
    if (this.handler.isRunning(sessionKey)) return true;

    return this.hasKnownThreadSession(channelId, sessionKey);
  }

  private buildHomeView(): { type: "home"; blocks: KnownBlock[] } {
    const blocks: object[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${PRODUCT_NAME}*\nStart a new task or check on running work.`,
        },
        accessory: {
          type: "image",
          image_url: "https://media1.tenor.com/m/lfDATg4Bhc0AAAAC/happy-cat.gif",
          alt_text: PRODUCT_NAME,
        },
      },
    ];

    // --- Running tasks ---
    const runningSessions = this.handler.getRunningSessions();

    blocks.push(
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Running Tasks (${runningSessions.length})`,
          emoji: true,
        },
      },
    );

    if (runningSessions.length === 0) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: "_No tasks running right now._" }],
      });
    } else {
      // Threshold for "stuck" detection (10 minutes)
      const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

      for (const session of runningSessions) {
        const channelId = session.sessionKey.split(":")[0];
        const channel = this.channels.get(channelId);
        const channelName = channel ? `#${channel.name}` : channelId;
        const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
        const elapsedStr = elapsed < 1 ? "<1 min" : `${elapsed} min`;

        // Check if task might be stuck
        const lastActivity = session.lastActivityAt ? Date.now() - session.lastActivityAt : 0;
        const isStuck = lastActivity > STUCK_THRESHOLD_MS;
        const statusText = isStuck ? "_stuck_" : "_running_";

        // Build status line: channel · status · time · step
        let statusLine = `${statusText} · ${elapsedStr}`;
        if (session.currentTool) {
          statusLine += ` · ${session.currentTool}`;
        }
        if (isStuck && lastActivity > 0) {
          const inactiveMin = Math.floor(lastActivity / 60000);
          statusLine += ` · idle ${inactiveMin}m`;
        }

        // Use context block for gray small text (like "No scheduled jobs.")
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*${channelName}* · ${statusLine}`,
            },
          ],
        });

        // Add Force Stop button as separate element if stuck
        if (isStuck) {
          blocks.push({
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: " ",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "Force Stop", emoji: true },
                action_id: `force_stop_${session.sessionKey.replace(/:/g, "_")}`,
                style: "danger",
              },
            ],
          });
        }
      }
    }

    // --- Cron jobs ---
    const periodicEvents = this.eventsWatcher?.getPeriodicEvents() ?? [];

    blocks.push(
      { type: "divider" },
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Scheduled Jobs (${periodicEvents.length})`,
          emoji: true,
        },
      },
    );

    if (periodicEvents.length === 0) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: "_No scheduled jobs._" }],
      });
    } else {
      for (const ev of periodicEvents) {
        const channelLabel =
          ev.platform === "slack"
            ? (() => {
                const channel = this.channels.get(ev.conversationId);
                const channelName = channel ? `#${channel.name}` : ev.conversationId;
                return `${ev.platform}:${channelName}`;
              })()
            : `${ev.platform}:${ev.conversationId}`;
        const nextStr = ev.nextRun
          ? new Date(ev.nextRun).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—";
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${ev.text}*\n└ \`${ev.schedule}\` · ${channelLabel} · Next: ${nextStr}`,
          },
        });
      }
    }

    // --- Footer ---
    blocks.push(
      { type: "divider" },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: "💡 @mention in a channel or send a DM to start a new task" },
        ],
      },
    );

    return { type: "home", blocks: blocks as KnownBlock[] };
  }

  private resolveStopTarget(channelId: string, threadTs?: string): string | null {
    const directTarget = resolveStopTarget({
      handler: this.handler,
      conversationId: channelId,
      sessionKey: resolveSlackSessionKey(channelId, threadTs),
    });
    if (directTarget) return directTarget;
    if (threadTs) return null;
    return resolveOnlyScopedStopTarget(this.handler, channelId);
  }

  private isStopText(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return normalized === "stop" || normalized === "/stop";
  }

  private createCommandAdapters(
    conversationId: string,
    userId: string,
    userName: string | undefined,
    text: string,
    ts: string,
    options: { ephemeralChannelId?: string; threadTs?: string } = {},
  ): BotAdapters {
    const message: ChatMessage = {
      id: ts,
      sessionKey: conversationId,
      conversationKind: options.ephemeralChannelId ? "shared" : "direct",
      userId,
      userName,
      text,
      attachments: [],
    };

    const respond = async (responseText: string) => {
      if (options.ephemeralChannelId) {
        await this.postEphemeral(
          options.ephemeralChannelId,
          userId,
          responseText,
          options.threadTs,
        );
        return;
      }
      const messageTs = await this.postMessage(conversationId, responseText);
      this.logBotResponse(conversationId, responseText, messageTs);
    };

    const respondMuted = async (responseText: string) => {
      const CONTEXT_TEXT_LIMIT = 3000;
      const blockText =
        responseText.length > CONTEXT_TEXT_LIMIT
          ? responseText.substring(0, CONTEXT_TEXT_LIMIT - 20) + "\n_(truncated)_"
          : responseText;
      const blocks = [{ type: "context", elements: [{ type: "mrkdwn", text: blockText }] }];
      if (options.ephemeralChannelId) {
        await this.postEphemeralBlocks(
          options.ephemeralChannelId,
          userId,
          responseText,
          blocks,
          options.threadTs,
        );
        return;
      }
      const messageTs = await this.postMessageBlocks(conversationId, responseText, blocks);
      this.logBotResponse(conversationId, responseText, messageTs);
    };

    const responseCtx: ChatResponseContext = {
      respond,
      replaceResponse: respond,
      respondDiagnostic: async (
        responseText: string,
        responseOptions?: { style?: "muted" | "error" },
      ) => {
        if (responseOptions?.style === "muted") {
          await respondMuted(responseText);
          return;
        }
        await respond(responseOptions?.style === "error" ? `_${responseText}_` : responseText);
      },
      respondToolResult: async (result: ChatToolResult) => {
        const duration = (result.durationMs / 1000).toFixed(1);
        await respond(
          `${result.isError ? "Error" : "Done"} ${result.toolName} (${duration}s)\n${result.result}`,
        );
      },
      setTyping: async () => {},
      setWorking: async () => {},
      uploadFile: async (filePath: string, title?: string) => {
        await this.uploadFile(conversationId, filePath, title);
      },
      deleteResponse: async () => {},
    };

    return {
      message,
      responseCtx,
      platform: this.getPlatformInfo(),
    };
  }

  private buildSlashCommandEvent(
    payload: {
      command: string;
      text?: string;
      channel_id: string;
      user_id: string;
      user_name?: string;
      thread_ts?: string;
    },
    options: { type?: BotEvent["type"]; includeText?: boolean; thread?: boolean } = {},
  ): { event: BotEvent; adapters: BotAdapters } {
    const conversationId = payload.channel_id;
    const isDirectMessage = conversationId.startsWith("D");
    const createdAt = new Date();
    const eventTs = (createdAt.getTime() / 1000).toFixed(6);
    const userName = payload.user_name ?? this.getUser(payload.user_id)?.userName;
    const commandSuffix = options.includeText ? payload.text?.trim() : undefined;
    const commandText = commandSuffix ? `${payload.command} ${commandSuffix}` : payload.command;
    const threadTs = options.thread ? payload.thread_ts : undefined;
    const sessionKey = options.thread
      ? resolveSlackSessionKey(conversationId, threadTs)
      : conversationId;

    this.logToFile(conversationId, {
      date: createdAt.toISOString(),
      ts: eventTs,
      user: payload.user_id,
      userName,
      text: commandText,
      attachments: [],
      isBot: false,
      ...(threadTs ? { threadTs } : {}),
    });

    const event: BotEvent = {
      type: options.type ?? (isDirectMessage ? "dm" : "mention"),
      conversationId,
      conversationKind: isDirectMessage ? "direct" : "shared",
      ts: eventTs,
      user: payload.user_id,
      text: commandText,
      attachments: [],
      ...(threadTs ? { thread_ts: threadTs } : {}),
      sessionKey,
    };

    const adapters = this.createCommandAdapters(
      conversationId,
      payload.user_id,
      userName,
      commandText,
      eventTs,
      isDirectMessage ? { threadTs } : { ephemeralChannelId: conversationId, threadTs },
    );

    return { event, adapters };
  }

  private createSlashCommandBot(conversationId: string, threadTs?: string): Bot {
    return {
      start: async () => {},
      postMessage: async (_channel: string, text: string) => {
        if (threadTs) {
          return this.postInThread(conversationId, threadTs, text);
        }
        return this.postMessage(conversationId, text);
      },
      updateMessage: async (channel: string, ts: string, text: string) => {
        await this.updateMessage(channel, ts, text);
      },
      enqueueEvent: (event: BotEvent) => this.enqueueEvent(event),
      getPlatformInfo: () => this.getPlatformInfo(),
    };
  }

  private async routeSlashLoginCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const { event, adapters } = this.buildSlashCommandEvent(payload, {
      type: payload.channel_id.startsWith("D") ? "dm" : "private_command",
      includeText: true,
    });
    await this.handler.handleEvent(event, this, adapters);
  }

  private async routeSlashNewCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const conversationId = payload.channel_id;
    if (!conversationId.startsWith("D")) {
      await this.postEphemeral(
        conversationId,
        payload.user_id,
        `為了避免誤清除共享上下文，${payload.command} 目前只能在與 ${PRODUCT_NAME} 的私訊中使用。`,
      );
      return;
    }

    const createdAt = new Date();
    const eventTs = (createdAt.getTime() / 1000).toFixed(6);
    const userName = payload.user_name ?? this.getUser(payload.user_id)?.userName;

    this.logToFile(conversationId, {
      date: createdAt.toISOString(),
      ts: eventTs,
      user: payload.user_id,
      userName,
      text: payload.command,
      attachments: [],
      isBot: false,
    });

    const commandBot = this.createSlashCommandBot(conversationId);
    await this.handler.handleNewCommand(conversationId, conversationId, commandBot);
  }

  private async routeSlashModelCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const { event, adapters } = this.buildSlashCommandEvent(payload, { includeText: true });
    await this.handler.handleEvent(event, this, adapters);
  }

  private async routeSlashSandboxCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    await this.routeSlashModelCommand(payload);
  }

  private async routeSlashAutoReplyCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    await this.routeSlashModelCommand(payload);
  }

  private async routeSlashSessionCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
    thread_ts?: string;
  }): Promise<void> {
    const { event, adapters } = this.buildSlashCommandEvent(payload, { thread: true });
    await this.handler.handleEvent(event, this, adapters);
  }

  private async routeSlashAdminCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
    thread_ts?: string;
  }): Promise<void> {
    const { event, adapters } = this.buildSlashCommandEvent(payload, { thread: true });
    await this.handler.handleEvent(event, this, adapters);
  }

  private setupEventHandlers(): void {
    this.socketClient.on("disconnect", (err: unknown) => {
      log.logWarning("Slack socket disconnect", err ? String(err) : "");
    });
    this.socketClient.on("error", (err: unknown) => {
      log.logWarning("Slack socket error", err ? String(err) : "");
    });
    this.socketClient.on("unable_to_socket_mode_start", (err: unknown) => {
      log.logWarning("Slack socket unable_to_start", err ? String(err) : "");
    });

    this.socketClient.on("app_mention", (payload) => this.handleAppMention(payload));
    this.socketClient.on("message", (payload) => this.handleMessageEvent(payload));
    this.socketClient.on("slash_commands", (payload) => void this.handleSlashCommand(payload));
    this.socketClient.on("app_home_opened", (payload) => this.handleAppHomeOpened(payload));
    this.socketClient.on("block_actions", (payload) => void this.handleBlockAction(payload));
  }

  private handleAppMention({ event, ack }: { event: unknown; ack: () => void }): void {
    const e = event as {
      text: string;
      channel: string;
      user: string;
      ts: string;
      thread_ts?: string;
      files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
    };

    // Skip DMs (handled by message event)
    if (e.channel.startsWith("D")) {
      ack();
      return;
    }

    // Top-level mentions use a persistent channel session.
    // Thread replies get their own isolated session (channelId:thread_ts).
    const sessionKey = resolveSlackSessionKey(e.channel, e.thread_ts);

    const slackEvent: SlackEvent = {
      type: "mention",
      conversationId: e.channel,
      conversationKind: "shared",
      channel: e.channel,
      ts: e.ts,
      thread_ts: e.thread_ts,
      user: e.user,
      text: this.stripOwnMention(e.text),
      files: e.files,
      sessionKey,
    };

    const attachmentsPromise = this.logUserMessage(slackEvent);

    // Only trigger processing for messages AFTER startup (not replayed old messages)
    if (this.startupTs && e.ts < this.startupTs) {
      log.logInfo(
        `[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
      );
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
      ack();
      return;
    }

    // Check for stop command - execute immediately, don't queue!
    if (this.isStopText(slackEvent.text)) {
      const stopTarget = this.resolveStopTarget(e.channel, e.thread_ts);
      if (stopTarget) {
        this.handler.handleStop(stopTarget, e.channel, this);
      } else {
        this.postMessage(e.channel, formatNothingRunning("slack"));
      }
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
      ack();
      return;
    }

    this.getQueue(this.resolveQueueKey(e.channel, sessionKey)).enqueue(async () => {
      slackEvent.attachments = await attachmentsPromise;
      const adapters = createSlackAdapters(slackEvent, this);
      return this.handler.handleEvent(
        slackEvent as unknown as import("../../adapter.js").BotEvent,
        this,
        adapters,
      );
    });

    ack();
  }

  private handleMessageEvent({ event, ack }: { event: unknown; ack: () => void }): void {
    const e = event as {
      text?: string;
      channel: string;
      user?: string;
      ts: string;
      thread_ts?: string;
      channel_type?: string;
      subtype?: string;
      bot_id?: string;
      app_id?: string;
      username?: string;
      bot_profile?: { id?: string; app_id?: string; name?: string; real_name?: string };
      blocks?: unknown[];
      attachments?: unknown[];
      files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
    };

    const hasFiles = !!e.files && e.files.length > 0;
    const hasSlackContent = !!e.text || hasFiles || !!e.blocks?.length || !!e.attachments?.length;
    const isOwnBotMessage =
      (!!e.user && e.user === this.botUserId) || (!!this.botId && e.bot_id === this.botId);
    if (isOwnBotMessage) {
      ack();
      return;
    }

    const isExternalBotMessage = !!e.bot_id || e.subtype === "bot_message";
    if (isExternalBotMessage) {
      if (e.subtype !== undefined && e.subtype !== "bot_message" && e.subtype !== "file_share") {
        ack();
        return;
      }
      if (!hasSlackContent) {
        ack();
        return;
      }
      void this.logExternalBotMessage(e).catch((err) => {
        log.logWarning("Failed to log Slack bot message", String(err));
      });
      ack();
      return;
    }

    if (!e.user) {
      ack();
      return;
    }
    if (e.subtype !== undefined && e.subtype !== "file_share") {
      ack();
      return;
    }
    if (!hasSlackContent) {
      ack();
      return;
    }

    const isDM = e.channel_type === "im";
    const conversationKind: ConversationKind = isDM ? "direct" : "shared";
    const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

    // Skip channel @mentions - already handled by app_mention event
    if (!isDM && isBotMention) {
      ack();
      return;
    }

    const isSharedThreadReply =
      !isDM && this.shouldTriggerSharedThreadReply(e.channel, e.thread_ts);
    const sessionKey =
      isDM || isSharedThreadReply ? resolveSlackSessionKey(e.channel, e.thread_ts) : undefined;

    const slackEvent: SlackEvent = {
      type: isDM ? "dm" : "mention",
      conversationId: e.channel,
      conversationKind,
      channel: e.channel,
      ts: e.ts,
      thread_ts: e.thread_ts,
      user: e.user,
      text: this.stripOwnMention(e.text),
      files: e.files,
      sessionKey,
    };

    const attachmentsPromise = this.logUserMessage(slackEvent);

    // Only trigger processing for messages AFTER startup (not replayed old messages)
    if (this.startupTs && e.ts < this.startupTs) {
      log.logInfo(
        `[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`,
      );
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
      ack();
      return;
    }

    // Stop command for DM or shared-channel thread reply (app_mention handles "@mikan stop").
    if ((isDM || (!isDM && e.thread_ts)) && this.isStopText(slackEvent.text)) {
      const stopTarget = this.resolveStopTarget(e.channel, e.thread_ts);
      if (stopTarget) {
        this.handler.handleStop(stopTarget, e.channel, this);
      } else {
        this.postMessage(e.channel, formatNothingRunning("slack"));
      }
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
      ack();
      return;
    }

    const enqueueTriggered = () => {
      const activeSessionKey =
        slackEvent.sessionKey ?? resolveSlackSessionKey(e.channel, e.thread_ts);
      // Auto-reply top-level channel messages start with no sessionKey because
      // they are only candidates until the policy allows them. Once triggered,
      // persist the resolved key on the event; otherwise the runtime fallback
      // treats the message ts as a thread session (`channel:ts`) instead of the
      // persistent top-level channel session.
      slackEvent.sessionKey = activeSessionKey;
      this.getQueue(this.resolveQueueKey(e.channel, activeSessionKey)).enqueue(async () => {
        slackEvent.attachments = await attachmentsPromise;
        const adapters = createSlackAdapters(slackEvent, this);
        return this.handler.handleEvent(
          slackEvent as unknown as import("../../adapter.js").BotEvent,
          this,
          adapters,
        );
      });
    };

    const logOnly = () => {
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
    };

    if (isDM || isSharedThreadReply) {
      enqueueTriggered();
      ack();
      return;
    }

    // Shared-channel non-mention, non-thread: gate via auto-reply policy.
    // evaluateAutoReplyPolicy never throws — judge errors/timeouts surface as
    // trigger:false with a distinct reason, and the user message has already
    // been queued for logging via logUserMessage above.
    evaluateAutoReplyPolicy({
      event: slackEvent as unknown as import("../../adapter.js").BotEvent,
      workingDir: this.workingDir,
    }).then((triggerResult) => {
      if (triggerResult.trigger) enqueueTriggered();
      else logOnly();
    });

    ack();
  }

  private async handleSlashCommand({
    body,
    ack,
  }: {
    body: unknown;
    ack: () => Promise<void>;
  }): Promise<void> {
    const payload = body as {
      command?: string;
      text?: string;
      channel_id?: string;
      user_id?: string;
      user_name?: string;
      thread_ts?: string;
    };

    await ack();

    if (!payload.command || !payload.channel_id || !payload.user_id) {
      return;
    }

    const handlerPromise =
      payload.command === "/pi-login"
        ? this.routeSlashLoginCommand({
            command: payload.command,
            text: payload.text,
            channel_id: payload.channel_id,
            user_id: payload.user_id,
            user_name: payload.user_name,
          })
        : payload.command === "/pi-new"
          ? this.routeSlashNewCommand({
              command: payload.command,
              channel_id: payload.channel_id,
              user_id: payload.user_id,
              user_name: payload.user_name,
            })
          : payload.command === "/pi-session"
            ? this.routeSlashSessionCommand({
                command: payload.command,
                channel_id: payload.channel_id,
                user_id: payload.user_id,
                user_name: payload.user_name,
                thread_ts: payload.thread_ts,
              })
            : payload.command === "/pi-model"
              ? this.routeSlashModelCommand({
                  command: payload.command,
                  text: payload.text,
                  channel_id: payload.channel_id,
                  user_id: payload.user_id,
                  user_name: payload.user_name,
                })
              : payload.command === "/pi-sandbox"
                ? this.routeSlashSandboxCommand({
                    command: payload.command,
                    text: payload.text,
                    channel_id: payload.channel_id,
                    user_id: payload.user_id,
                    user_name: payload.user_name,
                  })
                : payload.command === "/pi-auto-reply"
                  ? this.routeSlashAutoReplyCommand({
                      command: payload.command,
                      text: payload.text,
                      channel_id: payload.channel_id,
                      user_id: payload.user_id,
                      user_name: payload.user_name,
                    })
                  : payload.command === "/pi-admin"
                    ? this.routeSlashAdminCommand({
                        command: payload.command,
                        channel_id: payload.channel_id,
                        user_id: payload.user_id,
                        user_name: payload.user_name,
                        thread_ts: payload.thread_ts,
                      })
                    : null;

    if (!handlerPromise) {
      return;
    }

    handlerPromise.catch((err) => {
      log.logWarning("Slack slash command error", err instanceof Error ? err.message : String(err));
    });
  }

  private handleAppHomeOpened({ event, ack }: { event: unknown; ack: () => void }): void {
    const e = event as { user: string; tab: string };
    ack();
    if (e.tab !== "home") return;

    this.webClient.views
      .publish({
        user_id: e.user,
        view: this.buildHomeView(),
      })
      .catch((err) => {
        log.logWarning(`Failed to publish App Home view`, String(err));
      });
  }

  private async handleBlockAction({ body, ack }: { body: any; ack: () => void }): Promise<void> {
    const action = body.actions?.[0];
    if (!action || !action.action_id?.startsWith("force_stop_")) {
      ack();
      return;
    }

    ack();
    const sessionKey = action.action_id.replace("force_stop_", "").replace(/_/g, ":");
    const userId = body.user?.id;
    const channelId = body.container?.channel_id || sessionKey.split(":")[0];

    log.logInfo(`[Force Stop] User ${userId} requested force stop for ${sessionKey}`);

    // Use handler's forceStop method
    this.handler.forceStop(sessionKey);

    // Notify in channel
    await this.postMessage(channelId, formatForceStopped("slack", userId ?? "unknown"));

    // Refresh home tab
    if (userId) {
      this.webClient.views
        .publish({
          user_id: userId,
          view: this.buildHomeView(),
        })
        .catch((err) => {
          log.logWarning(`Failed to refresh App Home view`, String(err));
        });
    }
  }

  /**
   * Log a user message to log.jsonl after attachments are ready.
   */
  private async logUserMessage(event: SlackEvent): Promise<Attachment[]> {
    const user = this.users.get(event.user);
    let attachments: Attachment[] = [];
    let attachmentError: unknown;
    if (event.files) {
      try {
        attachments = await this.store.processAttachments(event.channel, event.files, event.ts);
      } catch (err) {
        attachmentError = err;
      }
    }
    // Always write the text log, even if attachment processing failed — we want
    // a record of the user message regardless of file-handling errors.
    this.logToFile(event.channel, {
      date: new Date(parseFloat(event.ts) * 1000).toISOString(),
      ts: event.ts,
      threadTs: event.thread_ts,
      user: event.user,
      userName: user?.userName,
      displayName: user?.displayName,
      text: event.text,
      attachments,
      isBot: false,
    });
    if (attachmentError) throw attachmentError;
    return attachments;
  }

  private async logExternalBotMessage(event: {
    channel: string;
    ts: string;
    thread_ts?: string;
    text?: string;
    subtype?: string;
    bot_id?: string;
    app_id?: string;
    username?: string;
    bot_profile?: { app_id?: string; name?: string; real_name?: string };
    blocks?: unknown[];
    attachments?: unknown[];
    files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
  }): Promise<Attachment[]> {
    const attachments = event.files
      ? await this.store.processAttachments(event.channel, event.files, event.ts)
      : [];
    const botName =
      event.username ?? event.bot_profile?.name ?? event.bot_profile?.real_name ?? event.bot_id;
    this.logToFile(event.channel, {
      date: new Date(parseFloat(event.ts) * 1000).toISOString(),
      ts: event.ts,
      threadTs: event.thread_ts,
      user: event.bot_id ? `bot:${event.bot_id}` : "external-bot",
      userName: botName,
      displayName: botName,
      text: buildSlackAppMessageText(event),
      attachments,
      isBot: true,
      botId: event.bot_id,
      appId: event.app_id ?? event.bot_profile?.app_id,
      subtype: event.subtype,
    });
    return attachments;
  }

  // ==========================================================================
  // Private - Backfill
  // ==========================================================================

  private async getExistingTimestamps(channelId: string): Promise<Set<string>> {
    const logPath = join(this.workingDir, channelId, "log.jsonl");
    const timestamps = new Set<string>();
    if (!existsSync(logPath)) return timestamps;

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.ts) timestamps.add(entry.ts);
      } catch (err) {
        log.logWarning(
          `Skipping malformed log entry at ${logPath}:${i + 1}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return timestamps;
  }

  private async backfillChannel(channelId: string, upperBoundTs?: string): Promise<number> {
    const existingTs = await this.getExistingTimestamps(channelId);

    // Find the biggest ts in log.jsonl
    let lastLoggedTs: string | undefined;
    for (const ts of existingTs) {
      if (!lastLoggedTs || parseFloat(ts) > parseFloat(lastLoggedTs)) lastLoggedTs = ts;
    }

    type Message = {
      user?: string;
      bot_id?: string;
      app_id?: string;
      username?: string;
      bot_profile?: { app_id?: string; name?: string; real_name?: string };
      blocks?: unknown[];
      attachments?: unknown[];
      text?: string;
      ts?: string;
      thread_ts?: string;
      subtype?: string;
      files?: Array<{ name: string }>;
    };
    const allMessages: Message[] = [];

    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = 3;

    do {
      const result = await this.webClient.conversations.history({
        channel: channelId,
        oldest: lastLoggedTs, // Only fetch messages newer than what we have
        latest: upperBoundTs, // Do not race live socket events after startup
        inclusive: false,
        limit: 1000,
        cursor,
      });
      if (result.messages) {
        allMessages.push(...(result.messages as Message[]));
      }
      cursor = result.response_metadata?.next_cursor;
      pageCount++;
    } while (cursor && pageCount < maxPages);

    // Filter: include mikan's messages, external app/bot messages, and user messages.
    const relevantMessages = allMessages.filter((msg) => {
      if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
      if (msg.user === this.botUserId) return true;
      const isExternalBotMessage = !!msg.bot_id || msg.subtype === "bot_message";
      if (isExternalBotMessage) {
        if (this.botId && msg.bot_id === this.botId) return false;
        if (
          msg.subtype !== undefined &&
          msg.subtype !== "bot_message" &&
          msg.subtype !== "file_share"
        ) {
          return false;
        }
        return (
          !!msg.text ||
          !!(msg.files && msg.files.length > 0) ||
          !!msg.blocks?.length ||
          !!msg.attachments?.length
        );
      }
      if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
      if (!msg.user) return false;
      if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
      return true;
    });

    // Reverse to chronological order
    relevantMessages.reverse();

    // Log each message to log.jsonl
    for (const msg of relevantMessages) {
      const isMikanMessage = msg.user === this.botUserId;
      const isExternalBotMessage =
        !isMikanMessage && (!!msg.bot_id || msg.subtype === "bot_message");
      if (isExternalBotMessage) {
        await this.logExternalBotMessage({ ...msg, channel: channelId, ts: msg.ts! });
        continue;
      }

      const user = this.users.get(msg.user!);
      const text = this.stripOwnMention(msg.text);
      const attachments = msg.files
        ? await this.store.processAttachments(channelId, msg.files, msg.ts!)
        : [];

      this.logToFile(channelId, {
        date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
        ts: msg.ts!,
        threadTs: msg.thread_ts,
        user: isMikanMessage ? "bot" : msg.user!,
        userName: isMikanMessage ? undefined : user?.userName,
        displayName: isMikanMessage ? undefined : user?.displayName,
        text,
        attachments,
        isBot: isMikanMessage,
      });
    }

    return relevantMessages.length;
  }

  private async backfillAllChannels(upperBoundTs?: string): Promise<void> {
    const startTime = Date.now();

    // Only backfill channels that already have a log.jsonl (mikan has interacted with them before)
    const channelsToBackfill: Array<[string, SlackChannel]> = [];
    for (const [channelId, channel] of this.channels) {
      const logPath = join(this.workingDir, channelId, "log.jsonl");
      if (existsSync(logPath)) {
        channelsToBackfill.push([channelId, channel]);
      }
    }

    log.logBackfillStart(channelsToBackfill.length);

    let totalMessages = 0;
    for (const [channelId, channel] of channelsToBackfill) {
      try {
        const count = await this.backfillChannel(channelId, upperBoundTs);
        if (count > 0) log.logBackfillChannel(channel.name, count);
        totalMessages += count;
      } catch (error) {
        log.logWarning(`Failed to backfill #${channel.name}`, String(error));
      }

      // Add delay between channels to avoid hitting Slack rate limits
      if (channelId !== channelsToBackfill[channelsToBackfill.length - 1][0]) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const durationMs = Date.now() - startTime;
    log.logBackfillComplete(totalMessages, durationMs);
  }

  // ==========================================================================
  // Private - Fetch Users/Channels
  // ==========================================================================

  private async fetchUsers(): Promise<void> {
    let cursor: string | undefined;
    do {
      const result = await this.webClient.users.list({ limit: 200, cursor });
      const members = result.members as
        | Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
        | undefined;
      if (members) {
        for (const u of members) {
          if (u.id && u.name && !u.deleted) {
            this.users.set(u.id, {
              id: u.id,
              userName: u.name,
              displayName: u.real_name || u.name,
            });
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }

  private async fetchChannels(): Promise<void> {
    // Fetch public/private channels
    let cursor: string | undefined;
    do {
      const result = await this.webClient.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const channels = result.channels as
        | Array<{ id?: string; name?: string; is_member?: boolean }>
        | undefined;
      if (channels) {
        for (const c of channels) {
          if (c.id && c.name && c.is_member) {
            this.channels.set(c.id, { id: c.id, name: c.name });
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    // Also fetch DM channels (IMs)
    cursor = undefined;
    do {
      const result = await this.webClient.conversations.list({
        types: "im",
        limit: 200,
        cursor,
      });
      const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
      if (ims) {
        for (const im of ims) {
          if (im.id) {
            // Use user's name as channel name for DMs
            const user = im.user ? this.users.get(im.user) : undefined;
            const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
            this.channels.set(im.id, { id: im.id, name });
          }
        }
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }
}
