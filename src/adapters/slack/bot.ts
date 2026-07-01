import { SocketModeClient } from "@slack/socket-mode";
import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
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
  ConversationKind,
  MessagingInfo,
} from "../../adapter.js";
import { resolveConversationSettings } from "../../config.js";
import type { EventsWatcher } from "../../events.js";
import * as log from "../../log.js";
import type { Attachment, ChannelStore } from "../../store.js";
import type {
  SlackBlockAction,
  SlackBlockActionBody,
  SlackChannel,
  SlackEvent,
  SlackUser,
} from "./types.js";
import { PRODUCT_NAME, formatForceStopped, formatNothingRunning } from "../../platform-messages.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
  withRetry,
} from "../shared.js";
import { processMessageIntake } from "../intake.js";
import { createSlackAdapters } from "./context.js";
import {
  hasMaterializedChatSession,
  registerThreadSession,
} from "../../sessions/agent-memory-file-manager.js";
import {
  isSlackThreadSessionKey,
  planSlackAdapterSession,
  planSlackEventAnchorRun,
  resolveSlackSessionKey,
} from "./session.js";
import { reportUserFacingError } from "../../observability/sentry.js";
import { renderSlackBlocks } from "./blocks.js";
import { backfillAllChannels, backfillChannel as backfillChannelImpl } from "./backfill.js";
import { buildHomeView } from "./home-view.js";
import {
  logExternalMessagingBotMessage as logExternalMessagingBotMessageImpl,
  logUserMessage as logUserMessageImpl,
  type ExternalBotMessageEvent,
} from "./message-logging.js";
import { fetchChannels, fetchUsers } from "./user-channel-sync.js";

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

// ---------------------------------------------------------------------------
// Shared mrkdwn truncation helper
// ---------------------------------------------------------------------------

const MRKDWN_CONTEXT_TEXT_LIMIT = 3000;

/**
 * Build a Slack context block whose text is capped at the mrkdwn limit.
 * Used for muted diagnostics and ephemeral command responses.
 */
export function buildMrkdwnContextBlock(text: string): object {
  const blockText =
    text.length > MRKDWN_CONTEXT_TEXT_LIMIT
      ? text.substring(0, MRKDWN_CONTEXT_TEXT_LIMIT - 20) + "\n_(truncated)_"
      : text;
  return { type: "context", elements: [{ type: "mrkdwn", text: blockText }] };
}

// ============================================================================
// Types
// ============================================================================

export type { SlackChannel, SlackEvent, SlackUser } from "./types.js";

// ============================================================================
// SlackMessagingBot
// ============================================================================

export class SlackMessagingBot implements MessagingBot {
  private socketClient: SocketModeClient;
  private webClient: WebClient;
  private handler: MessagingEventHandler;
  private workingDir: string;
  private store: ChannelStore;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private teamId: string | null = null;
  private ownMentionRegex: RegExp | null = null;
  private startupTs: string | null = null; // Messages older than this are just logged, not processed

  private users = new Map<string, SlackUser>();
  private channels = new Map<string, SlackChannel>();
  private queues = new Map<string, MessagingEventQueue>();
  private eventsWatcher: EventsWatcher | null = null;

  private createContext(event: SlackEvent): ConversationContext {
    return createSlackAdapters(event, this, {
      replyMode:
        resolveConversationSettings(join(this.workingDir, event.conversationId)).slack?.replyMode ??
        "top-level",
    });
  }

  constructor(
    handler: MessagingEventHandler,
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
    this.teamId = typeof auth.team_id === "string" ? auth.team_id : null;

    await Promise.all([
      fetchUsers({ webClient: this.webClient, users: this.users }),
      fetchChannels({ webClient: this.webClient, users: this.users, channels: this.channels }),
    ]);
    log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

    // Record startup time before opening the socket. Slack may replay older events;
    // those should be logged but not processed. Backfill runs in the background up
    // to this timestamp so startup is not blocked by one history call per channel.
    this.startupTs = (Date.now() / 1000).toFixed(6);

    this.setupEventHandlers();
    await this.socketClient.start();

    log.logConnected("Slack");

    void backfillAllChannels(
      { ...this.backfillDeps(), channels: this.channels },
      this.startupTs,
    ).catch((error) => {
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
      const payload = { channel, ...renderSlackBlocks(text) };
      const result = await this.webClient.chat.postMessage(payload);
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
      const payload = { channel, text, blocks: blocks as KnownBlock[] };
      const result = await this.webClient.chat.postMessage(payload);
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
      await this.postEphemeral(
        conversationId,
        userId,
        options?.style === "error" ? `_${text}_` : text,
      );
      return;
    }
    await this.postEphemeralBlocks(conversationId, userId, text, [buildMrkdwnContextBlock(text)]);
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
      const payload = { channel, ts, ...renderSlackBlocks(text) };
      await this.webClient.chat.update(payload);
    });
  }

  async startMessageStream(
    channel: string,
    text: string,
    threadTs?: string,
    recipientUserId?: string,
  ): Promise<string> {
    return slackRetry(async () => {
      const result = await this.webClient.apiCall("chat.startStream", {
        channel,
        markdown_text: text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(this.teamId ? { recipient_team_id: this.teamId } : {}),
        ...(recipientUserId ? { recipient_user_id: recipientUserId } : {}),
      });
      const ts = (result as { ts?: string }).ts;
      if (!ts) throw new Error("Slack chat.startStream did not return ts");
      return ts;
    });
  }

  async appendMessageStream(channel: string, ts: string, text: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.apiCall("chat.appendStream", {
        channel,
        ts,
        markdown_text: text,
      });
    });
  }

  async stopMessageStream(channel: string, ts: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.apiCall("chat.stopStream", { channel, ts });
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
      const payload = { channel, thread_ts: threadTs, ...renderSlackBlocks(text) };
      const result = await this.webClient.chat.postMessage(payload);
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
      const payload = {
        channel,
        thread_ts: threadTs,
        text, // fallback for notifications
        blocks: blocks as KnownBlock[],
      };
      const result = await this.webClient.chat.postMessage(payload);
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

  logBotResponse(
    channel: string,
    text: string,
    ts: string,
    threadTs?: string,
    slackBlocks?: object[],
  ): void {
    appendBotResponseLog(this.workingDir, channel, text, ts, threadTs, {
      platform: "slack",
      ...(slackBlocks ? { slackBlocks } : {}),
    });
  }

  getMessagingInfo(): MessagingInfo {
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
        const context = createSlackAdapters(slackEvent, this, {
          initialMessageTs: eventPlan.initialMessageTs,
          replyMode:
            resolveConversationSettings(join(this.workingDir, eventForRun.conversationId)).slack
              ?.replyMode ?? "top-level",
        });
        return this.handler.handleEvent(eventForRun, this, context);
      });
    });
    return true;
  }

  // ==========================================================================
  // Private - Event Handlers
  // ==========================================================================

  private getQueue(channelId: string): MessagingEventQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new MessagingEventQueue("Slack");
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

  private processSlackMessageIntake(options: {
    event: SlackEvent;
    attachmentsPromise: Promise<Attachment[]>;
    queueKey: string;
    isAutoReplyCandidate: boolean;
    onNotTriggered?: () => void;
  }): void {
    void processMessageIntake({
      eventBase: options.event as unknown as ConversationEvent,
      workingDir: this.workingDir,
      isAutoReplyCandidate: options.isAutoReplyCandidate,
      logEntryBase: {},
      processAttachments: () => options.attachmentsPromise,
      queueKey: options.queueKey,
      enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
      handler: this.handler,
      bot: this,
      createContext: (event) => this.createContext(event as SlackEvent),
      onNotTriggered: options.onNotTriggered,
      deferAttachmentsUntilRun: true,
    });
  }

  private buildHomeView(): { type: "home"; blocks: KnownBlock[] } {
    return buildHomeView({
      getRunningSessions: () => this.handler.getRunningSessions(),
      channels: this.channels,
      getPeriodicEvents: () => this.eventsWatcher?.getPeriodicEvents() ?? [],
    });
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
  ): ConversationContext {
    const message: ConversationMessage = {
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
      const blocks = [buildMrkdwnContextBlock(responseText)];
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

    const responder: ConversationResponder = {
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
      responder,
      platform: this.getMessagingInfo(),
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
    options: { type?: ConversationEvent["type"]; includeText?: boolean; thread?: boolean } = {},
  ): { event: ConversationEvent; context: ConversationContext } {
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
      isMessagingBot: false,
      ...(threadTs ? { threadTs } : {}),
    });

    const event: ConversationEvent = {
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

    const context = this.createCommandAdapters(
      conversationId,
      payload.user_id,
      userName,
      commandText,
      eventTs,
      isDirectMessage ? { threadTs } : { ephemeralChannelId: conversationId, threadTs },
    );

    return { event, context };
  }

  private async routeSlashLoginCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const { event, context } = this.buildSlashCommandEvent(payload, {
      type: payload.channel_id.startsWith("D") ? "dm" : "private_command",
      includeText: true,
    });
    await this.handler.handleEvent(event, this, context);
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
      isMessagingBot: false,
    });

    const commandMessagingBot: MessagingBot = {
      start: async () => {},
      postMessage: async (_channel: string, text: string) => this.postMessage(conversationId, text),
      updateMessage: async (channel: string, ts: string, text: string) =>
        this.updateMessage(channel, ts, text),
      enqueueEvent: (event: ConversationEvent) => this.enqueueEvent(event),
      getMessagingInfo: () => this.getMessagingInfo(),
    };
    await this.handler.handleNewCommand(conversationId, conversationId, commandMessagingBot);
  }

  private async routeSlashModelCommand(payload: {
    command: string;
    text?: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const { event, context } = this.buildSlashCommandEvent(payload, { includeText: true });
    await this.handler.handleEvent(event, this, context);
  }

  private async routeSlashSessionCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
    thread_ts?: string;
  }): Promise<void> {
    const { event, context } = this.buildSlashCommandEvent(payload, { thread: true });
    await this.handler.handleEvent(event, this, context);
  }

  private async routeSlashAdminCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
    thread_ts?: string;
  }): Promise<void> {
    const { event, context } = this.buildSlashCommandEvent(payload, { thread: true });
    await this.handler.handleEvent(event, this, context);
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
    this.socketClient.on(
      "interactive",
      (payload) =>
        void this.handleBlockAction(payload as { body: SlackBlockActionBody; ack: () => void }),
    );
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

    const mentionText = this.stripOwnMention(e.text);
    const slackEvent: SlackEvent = {
      type: "mention",
      conversationId: e.channel,
      conversationKind: "shared",
      channel: e.channel,
      ts: e.ts,
      thread_ts: e.thread_ts,
      user: e.user,
      text: mentionText || "Please respond to the recent conversation context.",
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

    this.processSlackMessageIntake({
      event: slackEvent,
      attachmentsPromise,
      queueKey: this.resolveQueueKey(e.channel, sessionKey),
      isAutoReplyCandidate: false,
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
    const isOwnMessagingBotMessage =
      (!!e.user && e.user === this.botUserId) || (!!this.botId && e.bot_id === this.botId);
    if (isOwnMessagingBotMessage) {
      ack();
      return;
    }

    const isExternalMessagingBotMessage = !!e.bot_id || e.subtype === "bot_message";
    if (isExternalMessagingBotMessage) {
      if (e.subtype !== undefined && e.subtype !== "bot_message" && e.subtype !== "file_share") {
        ack();
        return;
      }
      if (!hasSlackContent) {
        ack();
        return;
      }
      void this.logExternalMessagingBotMessage(e).catch((err) => {
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
    const isMessagingBotMention = e.text?.includes(`<@${this.botUserId}>`);

    // Skip channel @mentions - already handled by app_mention event
    if (!isDM && isMessagingBotMention) {
      ack();
      return;
    }

    const isThreadReply = !!e.thread_ts;
    const sessionKey = isDM ? resolveSlackSessionKey(e.channel, e.thread_ts) : undefined;

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

    // Stop command for DM only (app_mention handles shared-channel "@mikan stop").
    if (isDM && this.isStopText(slackEvent.text)) {
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
      this.processSlackMessageIntake({
        event: slackEvent,
        attachmentsPromise,
        queueKey: this.resolveQueueKey(e.channel, activeSessionKey),
        isAutoReplyCandidate: false,
      });
    };

    const logOnly = () => {
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
    };

    if (isDM) {
      enqueueTriggered();
      ack();
      return;
    }

    if (isThreadReply) {
      logOnly();
      ack();
      return;
    }

    const activeSessionKey = resolveSlackSessionKey(e.channel, e.thread_ts);
    slackEvent.sessionKey = activeSessionKey;
    this.processSlackMessageIntake({
      event: slackEvent,
      attachmentsPromise,
      queueKey: this.resolveQueueKey(e.channel, activeSessionKey),
      isAutoReplyCandidate: true,
      onNotTriggered: logOnly,
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

    const { command, text, channel_id, user_id, user_name, thread_ts } = payload;

    let handlerPromise: Promise<void> | null = null;
    if (command === "/pi-login") {
      handlerPromise = this.routeSlashLoginCommand({
        command,
        text,
        channel_id,
        user_id,
        user_name,
      });
    } else if (command === "/pi-new") {
      handlerPromise = this.routeSlashNewCommand({ command, channel_id, user_id, user_name });
    } else if (command === "/pi-session") {
      handlerPromise = this.routeSlashSessionCommand({
        command,
        channel_id,
        user_id,
        user_name,
        thread_ts,
      });
    } else if (command === "/pi-model") {
      handlerPromise = this.routeSlashModelCommand({
        command,
        text,
        channel_id,
        user_id,
        user_name,
      });
    } else if (command === "/pi-sandbox" || command === "/pi-auto-reply") {
      handlerPromise = this.routeSlashModelCommand({
        command,
        text,
        channel_id,
        user_id,
        user_name,
      });
    } else if (command === "/pi-admin") {
      handlerPromise = this.routeSlashAdminCommand({
        command,
        channel_id,
        user_id,
        user_name,
        thread_ts,
      });
    }

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

  private async handleBlockAction({
    body,
    ack,
  }: {
    body: SlackBlockActionBody;
    ack: () => void;
  }): Promise<void> {
    const action = body.actions?.[0];
    if (!action) {
      ack();
      return;
    }

    if (!action.action_id?.startsWith("force_stop_")) {
      ack();
      this.handleSlackInteraction(body, action);
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

  private handleSlackInteraction(body: SlackBlockActionBody, action: SlackBlockAction): void {
    const container = body.container ?? {};
    const channelId = container.channel_id;
    const userId = body.user?.id;
    if (!channelId || !userId) return;

    const selectedOption = action.selected_option;
    const selectedOptions = Array.isArray(action.selected_options)
      ? action.selected_options
      : undefined;
    const selectedText = selectedOption?.text?.text ?? selectedOption?.value;
    const selectedTexts = selectedOptions?.map((option) => option.text?.text ?? option.value);
    const valueText = selectedTexts?.length
      ? selectedTexts.join(", ")
      : (selectedText ?? action.value ?? action.action_id);
    const text = `[Slack action] ${action.action_id}: ${valueText}`;
    const ts = `action:${Date.now()}`;
    const threadTs = container.thread_ts;
    const sessionKey = resolveSlackSessionKey(channelId, threadTs);

    this.logToFile(channelId, {
      date: new Date().toISOString(),
      ts,
      ...(threadTs ? { threadTs } : {}),
      user: userId,
      userName: body.user?.username ?? body.user?.name,
      text,
      attachments: [],
      isMessagingBot: false,
      platform: "slack",
      slackInteraction: {
        type: "block_actions",
        actionId: action.action_id,
        blockId: action.block_id,
        actionType: action.type,
        value: action.value,
        selectedOption: selectedOption
          ? { text: selectedOption.text?.text, value: selectedOption.value }
          : undefined,
        selectedOptions: selectedOptions?.map((option) => ({
          text: option.text?.text,
          value: option.value,
        })),
        messageTs: container.message_ts,
      },
    });

    const event: ConversationEvent = {
      type: "slack_action",
      conversationId: channelId,
      conversationKind: channelId.startsWith("D") ? "direct" : "shared",
      ts,
      user: userId,
      text,
      attachments: [],
      ...(threadTs ? { thread_ts: threadTs } : {}),
      sessionKey,
    };

    this.getQueue(this.resolveQueueKey(channelId, sessionKey)).enqueue(async () => {
      const slackEvent: SlackEvent = {
        type: event.conversationKind === "direct" ? "dm" : "mention",
        conversationId: channelId,
        conversationKind: event.conversationKind,
        channel: channelId,
        ts,
        thread_ts: threadTs,
        user: userId,
        text,
        attachments: [],
        sessionKey,
      };
      return this.handler.handleEvent(event, this, this.createContext(slackEvent));
    });
  }

  /**
   * Log a user message to log.jsonl after attachments are ready.
   */
  private logUserMessage(event: SlackEvent): Promise<Attachment[]> {
    return logUserMessageImpl(
      {
        users: this.users,
        processAttachments: this.store.processAttachments.bind(this.store),
        logToFile: this.logToFile.bind(this),
      },
      event,
    );
  }

  private logExternalMessagingBotMessage(event: ExternalBotMessageEvent): Promise<Attachment[]> {
    return logExternalMessagingBotMessageImpl(
      {
        users: this.users,
        processAttachments: this.store.processAttachments.bind(this.store),
        logToFile: this.logToFile.bind(this),
      },
      event,
    );
  }

  // ==========================================================================
  // Private - Backfill
  // ==========================================================================

  private backfillDeps(): {
    workingDir: string;
    webClient: WebClient;
    botUserId: string | null;
    botId: string | null;
    users: Map<string, SlackUser>;
    stripOwnMention: (text?: string) => string;
    processAttachments: ChannelStore["processAttachments"];
    logToFile: (channel: string, entry: object) => void;
    logExternalMessagingBotMessage: (event: ExternalBotMessageEvent) => Promise<Attachment[]>;
  } {
    return {
      workingDir: this.workingDir,
      webClient: this.webClient,
      botUserId: this.botUserId,
      botId: this.botId,
      users: this.users,
      stripOwnMention: (text?: string) => this.stripOwnMention(text),
      processAttachments: this.store.processAttachments.bind(this.store),
      logToFile: this.logToFile.bind(this),
      logExternalMessagingBotMessage: (event) => this.logExternalMessagingBotMessage(event),
    };
  }

  private backfillChannel(channelId: string, upperBoundTs?: string): Promise<number> {
    return backfillChannelImpl(this.backfillDeps(), channelId, upperBoundTs);
  }
}
