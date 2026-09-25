import { SocketModeClient } from "@slack/socket-mode";
import type { KnownBlock } from "@slack/types";
import { WebAPIRateLimitedError, WebClient } from "@slack/web-api";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createConversationEvent,
  createConversationMessage,
  type MessagingBot,
  type ConversationContext,
  type ConversationEvent,
  type MessagingEventHandler,
  type ConversationResponder,
  type ChatToolResult,
  type ConversationKind,
  type MessagingInfo,
  type OfficeAddress,
  type PlatformHistoryMessage,
  type PlatformHistoryOptions,
  type PlatformUserInfo,
} from "../index.js";
import { createOfficeAddress, listRegisteredOffices, type Workspace } from "../../office/index.js";
import { COMMAND_MANIFEST, type SlackSlashRoute } from "../commands/manifest.js";
import {
  slackConversationAutoReplyMode,
  resolveConversationSettings,
} from "../../settings/index.js";
import { evaluateWithJev, JevNotConfiguredError } from "../../harness/index.js";
import type { EventScheduler } from "../../events/scheduler.js";
import * as log from "../../log.js";
import type { Attachment } from "../../types.js";
import type {
  SlackBlockAction,
  SlackBlockActionBody,
  SlackChannel,
  SlackEvent,
  SlackUser,
} from "./types.js";
import { isRecord, readTextFileIfExists } from "../../file-guards.js";
import { PRODUCT_NAME, formatForceStopped } from "../messages.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  MessagingIntakeTracker,
  saveIncomingAttachments,
  withRetry,
} from "../shared.js";
import { matchMagicWord, processMessageIntake } from "../intake.js";
import {
  readPlatformChannelKind,
  recordPlatformChannelKind,
  type PlatformChannelKind,
} from "../../office/projection.js";
import {
  AssistantThreadRegistry,
  handleAgentContextChanged,
  handleAgentDmOpened,
  handleAssistantThreadStarted,
  titleAssistantThread,
  type AgentContext,
  type AssistantSurfaceOps,
  type AssistantThreadPayload,
  type SuggestedPrompt,
} from "./assistant.js";
import { createSlackAdapters } from "./context.js";
import {
  hasMaterializedChatSession,
  registerThreadSession,
} from "../../sessions/chat-history-sync.js";
import type { SlackPersonaIdentity } from "./persona.js";
import { conversationIdOf } from "../../sessions/session-key.js";
import {
  isSlackThreadSessionKey,
  planSlackAdapterSession,
  planSlackEventAnchorRun,
  resolveSlackSessionKey,
} from "./session.js";
import { reportUserFacingError } from "../../observability/index.js";
import { recordSlackUpdate } from "./update-diagnostics.js";
import { renderSlackBlocks, resolveSlackMentions } from "./blocks.js";
import {
  querySlackTasks,
  formatTaskStatus,
  readTaskRoots,
  isTaskStatusQuestion,
} from "./task-status.js";
import { buildAutoReplyState, JEV_ADDRESSED_INSTRUCTIONS } from "./auto-reply-context.js";
import { buildTaskIntentState, classifyTaskIntent, type TaskIntent } from "./task-intent.js";
import { StreamStartLimiter } from "./stream-limits.js";

const SLACK_EVENT_ANCHOR_TEXT = "Working on it...";

interface SlackIncomingMessage {
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
}

type SlackHistoryMessage = Omit<SlackIncomingMessage, "channel" | "ts"> & { ts?: string };

function hasMessageContent(message: SlackHistoryMessage, includeBlocks = true): boolean {
  const content: Array<string | unknown[] | undefined> = [message.text, message.files];
  if (includeBlocks) content.push(message.blocks, message.attachments);
  return content.some((part) => !!part?.length);
}

function hasBotIdentity(message: SlackHistoryMessage): boolean {
  return !!message.bot_id || message.subtype === "bot_message";
}

const USER_MESSAGE_SUBTYPES = new Set([undefined, "file_share"]);
const BOT_MESSAGE_SUBTYPES = new Set([...USER_MESSAGE_SUBTYPES, "bot_message"]);

interface CommandAdapterInput {
  conversationId: string;
  userId: string;
  userName: string | undefined;
  text: string;
  ts: string;
  ephemeralChannelId?: string;
  threadTs?: string;
  sessionKey?: string;
}

const MAX_STREAM_TEXT_CHARS = 12_000;

export function chunkStreamText(text: string, limit = MAX_STREAM_TEXT_CHARS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks;
}

function slackIsRateLimited(err: Error): boolean {
  if (err instanceof WebAPIRateLimitedError) return true;
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

const MRKDWN_CONTEXT_TEXT_LIMIT = 3000;

export function buildMrkdwnContextBlock(text: string): object {
  const blockText =
    text.length > MRKDWN_CONTEXT_TEXT_LIMIT
      ? text.substring(0, MRKDWN_CONTEXT_TEXT_LIMIT - 20) + "\n_(truncated)_"
      : text;
  return { type: "context", elements: [{ type: "mrkdwn", text: blockText }] };
}

export type { SlackChannel, SlackEvent, SlackUser } from "./types.js";

class AttachmentDownloadHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function isRetryableAttachmentDownloadError(error: unknown): boolean {
  if (!(error instanceof AttachmentDownloadHttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

export class SlackMessagingBot implements MessagingBot {
  private socketClient: SocketModeClient;
  private webClient: WebClient;
  private readonly statusClient: WebClient;
  private readonly statusUpdates = new Map<string, Promise<void>>();
  private handler: MessagingEventHandler;
  private workspace: Workspace;
  private botToken: string;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private teamId: string | null = null;
  private ownMentionRegex: RegExp | null = null;
  private startupTs: string | null = null;

  private users = new Map<string, SlackUser>();
  private channels = new Map<string, SlackChannel>();
  private assistantThreads = new AssistantThreadRegistry();
  private streamStarts = new StreamStartLimiter();
  private stopped = false;
  private queues = new Map<string, MessagingEventQueue>();
  private intake = new MessagingIntakeTracker("Slack");
  private eventScheduler: EventScheduler | null = null;

  private conversationDir(channelId: string): string {
    return this.workspace.office(createOfficeAddress("slack", channelId)).dir;
  }

  private resolveReplyMode(address: OfficeAddress): "top-level" | "thread" {
    return (
      resolveConversationSettings(this.workspace.office(address)).slack?.replyMode ?? "top-level"
    );
  }

  private createContext(event: SlackEvent): ConversationContext {
    const context = createSlackAdapters(event, this, {
      replyMode: this.resolveReplyMode(event.address),
    });
    if (event.conversationKind === "direct") {
      context.responder.getTaskStatus = (key) =>
        querySlackTasks(
          this.conversationDir(event.channel),
          event.channel,
          this.handler
            .getRunningSessions()
            .filter(
              (s) => s.address.platform === "slack" && s.address.conversationId === event.channel,
            ),
          key,
        );
    }
    if (
      event.conversationKind === "direct" &&
      event.thread_ts &&
      this.isTaskThread(event.channel, event.thread_ts)
    ) {
      let notified = false;
      context.responder.notifyCompletion = async () => {
        if (notified) return;
        const text = `<@${event.user}> 這一輪處理已結束，請查看上方結果。`;
        const ts = await this.postInThread(event.channel, event.thread_ts!, text);
        notified = true;
        this.logBotResponse(event.channel, text, ts, event.thread_ts);
      };
    }
    if (event.conversationKind === "direct" && !event.thread_ts) {
      context.responder.startTask = async (message, task) => {
        if (this.stopped) throw new Error("Slack is shutting down; task was not started.");
        await context.responder.deleteResponse();
        const root = await this.postMessage(event.channel, message);
        this.logToFile(event.channel, {
          date: new Date().toISOString(),
          ts: root,
          user: "bot",
          text: message,
          isMessagingBot: true,
          taskRoot: true,
        });
        const sessionKey = resolveSlackSessionKey(event.channel, root);
        try {
          registerThreadSession({
            conversationDir: this.conversationDir(event.channel),
            sessionKey,
          });
          const child: SlackEvent = {
            ...event,
            ts: `task:${root}`,
            thread_ts: root,
            sessionKey,
            text: task,
          };
          if (
            !this.getQueue(sessionKey).enqueue(async () => {
              try {
                await this.handler.handleEvent(
                  {
                    ...child,
                    attachments: child.attachments?.map((a) => ({
                      name: a.original,
                      localPath: a.localPath,
                    })),
                  },
                  this,
                  this.createContext(child),
                );
              } catch (error) {
                reportUserFacingError(error, {
                  domain: "mikan",
                  surface: "task_handoff",
                  operation: "start_task_run",
                  severity: "error",
                  platform: "slack",
                  context: { conversationId: event.channel, sessionKey, threadTs: root },
                });
                await this.postInThread(
                  event.channel,
                  root,
                  "Task could not start. Please reply here to try again.",
                );
                throw error;
              }
            })
          )
            throw new Error("Task queue is closed.");
        } catch (error) {
          await this.updateMessage(event.channel, root, `${message}\n\nTask could not start.`);
          throw error;
        }
        return sessionKey;
      };
    }
    return context;
  }

  constructor(
    handler: MessagingEventHandler,
    config: { appToken: string; botToken: string; workspace: Workspace },
  ) {
    this.handler = handler;
    this.workspace = config.workspace;
    this.botToken = config.botToken;
    this.socketClient = new SocketModeClient({
      appToken: config.appToken,
      clientPingTimeout: 12_000,
    });
    this.webClient = new WebClient(config.botToken);
    this.statusClient = new WebClient(config.botToken, {
      timeout: 3000,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
  }

  setEventScheduler(scheduler: EventScheduler): void {
    this.eventScheduler = scheduler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const auth = await this.webClient.auth.test();
    this.botUserId = auth.user_id as string;
    this.botId = typeof auth.bot_id === "string" ? auth.bot_id : null;
    this.teamId = typeof auth.team_id === "string" ? auth.team_id : null;

    await Promise.all([this.fetchUsers(), this.fetchChannels()]);
    if (this.stopped) return;
    log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);
    this.backfillChannelKinds();

    this.startupTs = (Date.now() / 1000).toFixed(6);

    this.setupEventHandlers();
    await this.socketClient.start();

    log.logConnected("Slack");

    void this.backfillAllChannels(this.startupTs).catch((error) => {
      log.logWarning("Slack backfill failed", String(error));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      await this.socketClient.disconnect();
    } finally {
      await this.intake.close();
      await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    }
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

  private resolveMentions(text: string): string {
    return resolveSlackMentions(text, this.users.values());
  }

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: SlackPersonaIdentity,
  ): Promise<string> {
    return slackRetry(async () => {
      const payload = {
        channel,
        thread_ts: threadTs,
        username: identity?.username,
        icon_emoji: identity?.iconEmoji,
        ...renderSlackBlocks(this.resolveMentions(text)),
      };
      const result = await this.webClient.chat.postMessage(payload);
      return result.ts as string;
    });
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    const name = emoji.replace(/^:|:$/g, "");
    await slackRetry(async () => {
      try {
        await this.webClient.reactions.add({ channel, timestamp: messageTs, name });
      } catch (err) {
        if ((err as { data?: { error?: string } })?.data?.error === "already_reacted") return;
        throw err;
      }
    });
  }

  async postEphemeral(
    channel: string,
    user: string,
    text: string,
    threadTs?: string,
    blocks?: object[],
  ): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.chat.postEphemeral({
        channel,
        user,
        text,
        blocks: blocks as KnownBlock[] | undefined,
        thread_ts: threadTs || undefined,
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
    return this.postEphemeral(channel, user, text, threadTs, blocks);
  }

  async postMessageBlocks(
    channel: string,
    text: string,
    blocks: object[],
    threadTs?: string,
  ): Promise<string> {
    return slackRetry(async () => {
      const payload = {
        channel,
        text,
        blocks: blocks as KnownBlock[],
        thread_ts: threadTs,
      };
      const result = await this.webClient.chat.postMessage(payload);
      return result.ts as string;
    });
  }

  async updateMessageBlocks(
    channel: string,
    ts: string,
    text: string,
    blocks: object[],
  ): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.chat.update({ channel, ts, text, blocks: blocks as KnownBlock[] });
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

  async openDirectConversation(userId: string): Promise<string> {
    return slackRetry(async () => {
      const result = await this.webClient.conversations.open({ users: userId });
      const channelId = result.channel?.id;
      if (!channelId) {
        throw new Error(`Failed to open DM for user ${userId}`);
      }
      return channelId;
    });
  }

  async fetchHistory(
    channel: string,
    options?: PlatformHistoryOptions,
  ): Promise<PlatformHistoryMessage[]> {
    const limit = Math.min(Math.max(options?.limit ?? 200, 1), 999);
    const threadTs = options?.threadTs;
    return slackRetry(async () => {
      const result = threadTs
        ? await this.webClient.conversations.replies({
            channel,
            ts: threadTs,
            oldest: options?.oldest || undefined,
            inclusive: options?.oldest ? false : undefined,
            limit,
          })
        : await this.webClient.conversations.history({
            channel,
            oldest: options?.oldest || undefined,
            inclusive: options?.oldest ? false : undefined,
            limit,
          });
      const messages = (result.messages ?? []) as Array<{
        ts?: string;
        thread_ts?: string;
        user?: string;
        bot_id?: string;
        subtype?: string;
        text?: string;
      }>;
      const mapped = messages
        .filter((msg): msg is typeof msg & { ts: string } => !!msg.ts)
        .filter((msg) => msg.ts !== threadTs)
        .map((msg) => {
          const user = msg.user ? this.users.get(msg.user) : undefined;
          const message: PlatformHistoryMessage = {
            ts: msg.ts,
            text: msg.text ?? "",
            isBot: !!msg.bot_id || msg.subtype === "bot_message" || user?.isBot === true,
          };
          if (msg.thread_ts && msg.thread_ts !== msg.ts) message.threadTs = msg.thread_ts;
          if (msg.user) message.userId = msg.user;
          if (user) message.userName = user.userName;
          return message;
        });
      return threadTs ? mapped : mapped.toReversed();
    });
  }

  async listUsers(): Promise<PlatformUserInfo[]> {
    await slackRetry(() => this.fetchUsers());
    return this.getAllUsers().map((user) => ({
      id: user.id,
      userName: user.userName,
      displayName: user.displayName,
      isBot: user.isBot === true,
    }));
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    return slackRetry(async () => {
      const payload = { channel, ts, ...renderSlackBlocks(this.resolveMentions(text)) };
      try {
        await this.webClient.chat.update(payload);
      } catch (error) {
        recordSlackUpdate(this, { channel, ts }, text, payload, { error });
        throw error;
      }
      recordSlackUpdate(this, { channel, ts }, text, payload, { success: true });
    });
  }

  tryReserveStreamStart(): boolean {
    return this.streamStarts.tryReserve();
  }

  async startMessageStream(
    channel: string,
    text: string,
    threadTs?: string,
    recipientUserId?: string,
  ): Promise<string> {
    const [head, ...tail] = chunkStreamText(text);
    const ts = await slackRetry(async () => {
      const result = await this.webClient.apiCall("chat.startStream", {
        channel,
        markdown_text: this.resolveMentions(head ?? ""),
        thread_ts: threadTs || undefined,
        recipient_team_id: this.teamId || undefined,
        recipient_user_id: recipientUserId || undefined,
      });
      const streamTs = (result as { ts?: string }).ts;
      if (!streamTs) throw new Error("Slack chat.startStream did not return ts");
      return streamTs;
    });
    for (const part of tail) await this.appendStreamChunk(channel, ts, part);
    return ts;
  }

  async appendMessageStream(channel: string, ts: string, text: string): Promise<void> {
    for (const part of chunkStreamText(text)) {
      await this.appendStreamChunk(channel, ts, part);
    }
  }

  private async appendStreamChunk(channel: string, ts: string, text: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.apiCall("chat.appendStream", {
        channel,
        ts,
        markdown_text: this.resolveMentions(text),
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

  async setAssistantStatus(channel: string, threadTs: string, status: string): Promise<void> {
    const key = `${channel}:${threadTs}`;
    const previous = this.statusUpdates.get(key) ?? Promise.resolve();
    const update = previous
      .catch(() => undefined)
      .then(async () => {
        await this.statusClient.assistant.threads.setStatus({
          channel_id: channel,
          thread_ts: threadTs,
          status,
        });
      });
    this.statusUpdates.set(key, update);
    try {
      await update;
    } finally {
      if (this.statusUpdates.get(key) === update) this.statusUpdates.delete(key);
    }
  }

  async setAssistantSuggestedPrompts(
    channel: string,
    threadTs: string | undefined,
    prompts: SuggestedPrompt[],
  ): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.assistant.threads.setSuggestedPrompts({
        channel_id: channel,
        thread_ts: threadTs || undefined,
        prompts,
      });
    });
  }

  async setAssistantTitle(channel: string, threadTs: string, title: string): Promise<void> {
    return slackRetry(async () => {
      await this.webClient.assistant.threads.setTitle({
        channel_id: channel,
        thread_ts: threadTs,
        title,
      });
    });
  }

  private assistantOps(): AssistantSurfaceOps {
    return {
      postInThread: (channel, threadTs, text) => this.postInThread(channel, threadTs, text),
      setSuggestedPrompts: (channel, threadTs, prompts) =>
        this.setAssistantSuggestedPrompts(channel, threadTs, prompts),
      setTitle: (channel, threadTs, title) => this.setAssistantTitle(channel, threadTs, title),
      channelName: (channelId) => this.channels.get(channelId)?.name,
    };
  }

  private handleAssistantThreadStarted({ event, ack }: { event: unknown; ack: () => void }): void {
    ack();
    const payload = event as { assistant_thread?: AssistantThreadPayload };
    if (!payload.assistant_thread) return;
    void handleAssistantThreadStarted(
      this.assistantOps(),
      this.assistantThreads,
      payload.assistant_thread,
    );
  }

  private handleAgentContextChangedEvent({
    event,
    ack,
  }: {
    event: unknown;
    ack: () => void;
  }): void {
    ack();
    const payload = event as {
      assistant_thread?: AssistantThreadPayload;
      channel_id?: string;
      channel?: string;
      context?: AgentContext;
    };
    if (payload.assistant_thread) {
      handleAgentContextChanged(this.assistantThreads, payload.assistant_thread);
      return;
    }
    const channelId = payload.channel_id ?? payload.channel;
    if (channelId) {
      handleAgentContextChanged(this.assistantThreads, {
        channel_id: channelId,
        context: payload.context,
      });
    }
  }

  async postInThread(
    channel: string,
    threadTs: string,
    text: string,
    identity?: SlackPersonaIdentity,
  ): Promise<string> {
    return identity
      ? this.postMessage(channel, text, threadTs, identity)
      : this.postMessage(channel, text, threadTs);
  }

  async postInThreadBlocks(
    channel: string,
    threadTs: string,
    text: string,
    blocks: object[],
  ): Promise<string> {
    return this.postMessageBlocks(channel, text, blocks, threadTs);
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
    appendChannelLog(this.workspace.office(createOfficeAddress("slack", channel)), entry);
  }

  logBotResponse(
    channel: string,
    text: string,
    ts: string,
    threadTs?: string,
    slackBlocks?: object[],
  ): void {
    appendBotResponseLog(
      this.workspace.office(createOfficeAddress("slack", channel)),
      text,
      ts,
      threadTs,
      {
        platform: "slack",
        slackBlocks,
      },
    );
  }

  ownsBlockKitMessage(channel: string, ts: string, threadTs?: string): boolean {
    const content = readTextFileIfExists(join(this.conversationDir(channel), "log.jsonl"));
    if (content === undefined) return false;
    for (const line of content.trim().split("\n").toReversed()) {
      try {
        const entry: unknown = JSON.parse(line);
        if (!isRecord(entry) || entry.ts !== ts) continue;
        return (
          entry.isMessagingBot === true &&
          entry.platform === "slack" &&
          Array.isArray(entry.slackBlocks) &&
          entry.threadTs === threadTs
        );
      } catch {
        continue;
      }
    }
    return false;
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "slack",
      workspaceId: this.teamId || undefined,
      trustModel: "membership",
      formattingGuide:
        "## Slack Formatting\nWrite standard Markdown/GFM: **bold**, _italic_, ~~strike~~, `code`, fenced code blocks, [links](url), lists, and pipe tables (rendered as native Slack tables).\nDo NOT use Slack mrkdwn syntax like *single-asterisk bold* or <url|label> links.",
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
    return queue.enqueue(async () => {
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
          conversationDir: this.conversationDir(conversationId),
          sessionKey: eventForRun.sessionKey,
        });
      }

      const runQueueKey = planSlackAdapterSession(eventForRun, {
        initialMessageTs: eventPlan.initialMessageTs,
      }).sessionKey;
      const run = async () => {
        const slackEvent = createConversationEvent({
          platform: "slack",
          address: eventForRun.address,
          type: eventForRun.type as SlackEvent["type"],
          conversationId,
          conversationKind: eventForRun.conversationKind,
          channel: conversationId,
          ts: eventForRun.ts,
          thread_ts: eventForRun.thread_ts,
          user: eventForRun.user,
          text: eventForRun.text,
          attachments: eventForRun.attachments,
          sessionKey: eventForRun.sessionKey,
        }) as SlackEvent;
        const context = createSlackAdapters(slackEvent, this, {
          initialMessageTs: eventPlan.initialMessageTs,
          replyMode: this.resolveReplyMode(eventForRun.address),
        });
        return this.handler.handleEvent(eventForRun, this, context);
      };
      const runQueue = this.getQueue(runQueueKey);
      if (!runQueue.enqueue(run)) {
        await runQueue.close();
        await run();
      }
    });
  }

  private getQueue(channelId: string): MessagingEventQueue {
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = new MessagingEventQueue("Slack");
      if (this.stopped) void queue.close();
      this.queues.set(channelId, queue);
    }
    return queue;
  }

  private resolveQueueKey(conversationId: string, sessionKey: string): string {
    if (!isSlackThreadSessionKey(sessionKey)) return sessionKey;
    if (this.handler.isRunning(createOfficeAddress("slack", conversationId), sessionKey)) {
      return sessionKey;
    }
    return this.hasKnownThreadSession(conversationId, sessionKey) ? sessionKey : conversationId;
  }

  private isTaskThread(channel: string, root: string): boolean {
    return readTaskRoots(this.conversationDir(channel)).has(root);
  }

  private hasRunningTaskThread(channel: string): boolean {
    const roots = readTaskRoots(this.conversationDir(channel));
    if (!roots.size) return false;
    return this.handler
      .getRunningSessions()
      .some(
        (s) =>
          s.address.platform === "slack" &&
          s.address.conversationId === channel &&
          [...roots.keys()].some((root) => resolveSlackSessionKey(channel, root) === s.sessionKey),
      );
  }

  private hasKnownThreadSession(conversationId: string, sessionKey: string): boolean {
    return hasMaterializedChatSession({
      conversationDir: this.conversationDir(conversationId),
      sessionKey,
    });
  }

  private channelKindFor(channelId: string): PlatformChannelKind | undefined {
    if (channelId.startsWith("D")) return "im";
    const channel = this.channels.get(channelId);
    if (!channel) return undefined;
    if (channel.name.startsWith("DM:")) return "im";
    if (channel.isExternallyShared) return "external";
    if (channel.isPrivate === true) return "private_channel";
    if (channel.isPrivate === false) return "public_channel";
    return undefined;
  }

  private backfillChannelKinds(): void {
    let recorded = 0;
    for (const record of listRegisteredOffices(this.workspace.stateDir)) {
      if (record.platform !== "slack") continue;
      const kind = this.channelKindFor(record.conversationId);
      if (!kind) continue;
      try {
        const office = this.workspace.office(record);
        if (readPlatformChannelKind(office) === kind) continue;
        recordPlatformChannelKind(office, kind);
        recorded++;
      } catch (err) {
        log.logWarning("Failed to backfill Slack channel kind", String(err));
      }
    }
    if (recorded > 0) log.logInfo(`Recorded channel kind for ${recorded} Slack offices`);
  }

  private processSlackMessageIntake(options: {
    event: SlackEvent;
    attachmentsPromise: Promise<Attachment[]>;
    queueKey: string;
    addressed: boolean;
    magicWordAddressed?: boolean;
  }): Promise<void> {
    const kind = this.channelKindFor(options.event.address.conversationId);
    if (kind) {
      try {
        recordPlatformChannelKind(this.workspace.office(options.event.address), kind);
      } catch (err) {
        log.logWarning("Failed to record Slack channel kind", String(err));
      }
    }
    const absorbAttachmentFailure = () => {
      void options.attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
    };
    return processMessageIntake({
      eventBase: options.event as unknown as ConversationEvent,
      addressed: options.addressed,
      magicWord: {
        addressed: options.magicWordAddressed ?? options.addressed,
        scopeFallback: "top-level",
      },
      busyPolicy: "queue",
      logEntryBase: {},
      processAttachments: () => options.attachmentsPromise,
      queueKey: options.queueKey,
      enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
      handler: this.handler,
      bot: this,
      createContext: (event) => this.createContext(event as SlackEvent),
      deferAttachmentsUntilRun: true,
    }).then(
      (outcome) => {
        if (outcome !== "enqueued") absorbAttachmentFailure();
      },
      (err) => {
        log.logWarning("Slack message intake failed", String(err));
        absorbAttachmentFailure();
      },
    );
  }

  private appendRunningTasks(blocks: object[]): void {
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
      return;
    }

    const stuckThresholdMs = 10 * 60 * 1000;
    for (const session of runningSessions) {
      const channelId = conversationIdOf(session.sessionKey);
      const channelName = this.channels.get(channelId)?.name;
      const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
      const elapsedStr = elapsed < 1 ? "<1 min" : `${elapsed} min`;
      const lastActivity = session.lastActivityAt ? Date.now() - session.lastActivityAt : 0;
      const isStuck = lastActivity > stuckThresholdMs;
      let statusLine = `${isStuck ? "_stuck_" : "_running_"} · ${elapsedStr}`;
      if (session.currentTool) statusLine += ` · ${session.currentTool}`;
      if (isStuck) statusLine += ` · idle ${Math.floor(lastActivity / 60000)}m`;
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*${channelName ? `#${channelName}` : channelId}* · ${statusLine}`,
          },
        ],
      });
      if (isStuck) {
        blocks.push({
          type: "context",
          elements: [
            { type: "mrkdwn", text: " " },
            {
              type: "button",
              text: { type: "plain_text", text: "Force Stop", emoji: true },
              action_id: `force_stop_${session.sessionKey.replace(/:/g, "_")}`,
              value: session.sessionKey,
              style: "danger",
            },
          ],
        });
      }
    }
  }

  private appendScheduledJobs(blocks: object[], dmChannelId: string | undefined): void {
    const periodicEvents =
      dmChannelId && this.eventScheduler
        ? this.eventScheduler.periodicEvents(createOfficeAddress("slack", dmChannelId))
        : [];
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
      return;
    }

    for (const event of periodicEvents) {
      const channel =
        event.platform === "slack" ? this.channels.get(event.conversationId) : undefined;
      const channelId = channel ? `#${channel.name}` : event.conversationId;
      const channelLabel = `${event.platform}:${channelId}`;
      const nextRun = event.nextRun
        ? new Date(event.nextRun).toLocaleString("en-US", {
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
          text: `*${event.text}*\n└ \`${event.schedule}\` · ${channelLabel} · Next: ${nextRun}`,
        },
      });
    }
  }

  private buildHomeView(dmChannelId: string | undefined): { type: "home"; blocks: KnownBlock[] } {
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
    this.appendRunningTasks(blocks);
    this.appendScheduledJobs(blocks, dmChannelId);
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

  private createCommandAdapters(input: CommandAdapterInput): ConversationContext {
    const { conversationId, userId, userName, text, ts, ...options } = input;
    const message = createConversationMessage({
      platform: "slack",
      conversationId,
      id: ts,
      sessionKey: options.sessionKey ?? conversationId,
      conversationKind: options.ephemeralChannelId ? "shared" : "direct",
      userId,
      userName,
      text,
      attachments: [],
    });

    const respond = async (responseText: string, blocks?: object[]) => {
      if (options.ephemeralChannelId) {
        await this.postEphemeral(
          options.ephemeralChannelId,
          userId,
          responseText,
          options.threadTs,
          blocks,
        );
        return;
      }
      const messageTs = blocks
        ? await this.postMessageBlocks(conversationId, responseText, blocks)
        : await this.postMessage(conversationId, responseText);
      this.logBotResponse(conversationId, responseText, messageTs);
    };

    const responder: ConversationResponder = {
      respond,
      replaceResponse: (responseText) => respond(responseText),
      respondDiagnostic: async (
        responseText: string,
        responseOptions?: { style?: "muted" | "error" },
      ) => {
        if (responseOptions?.style === "muted") {
          await respond(responseText, [buildMrkdwnContextBlock(responseText)]);
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
      address: message.address,
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
      threadTs: threadTs || undefined,
    });

    const event = createConversationEvent({
      platform: "slack",
      conversationId,
      type: options.type ?? (isDirectMessage ? "dm" : "mention"),
      conversationKind: isDirectMessage ? "direct" : "shared",
      ts: eventTs,
      user: payload.user_id,
      text: commandText,
      attachments: [],
      thread_ts: threadTs || undefined,
      sessionKey,
    });

    const context = this.createCommandAdapters({
      conversationId,
      userId: payload.user_id,
      userName,
      text: commandText,
      ts: eventTs,
      ephemeralChannelId: isDirectMessage ? undefined : conversationId,
      threadTs,
      sessionKey,
    });

    return { event, context };
  }

  private async routeSlashCommand(
    route: SlackSlashRoute,
    payload: {
      command: string;
      text?: string;
      channel_id: string;
      user_id: string;
      user_name?: string;
      thread_ts?: string;
    },
  ): Promise<void> {
    const { event, context } = this.buildSlashCommandEvent(payload, {
      includeText: route.includeText,
      thread: route.thread,
      type: route.privateCommand
        ? payload.channel_id.startsWith("D")
          ? ("dm" as const)
          : ("private_command" as const)
        : undefined,
    });
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

    this.socketClient.on("app_mention", (payload) => {
      void this.intake.run(() => this.handleAppMention(payload));
    });
    this.socketClient.on("message", (payload) => {
      void this.intake.run(() => this.handleMessageEvent(payload));
    });
    this.socketClient.on("slash_commands", (payload) => {
      void this.intake.run(() => this.handleSlashCommand(payload));
    });
    this.socketClient.on("app_home_opened", (payload) => {
      void this.intake.run(() => this.handleAppHomeOpened(payload));
    });
    this.socketClient.on("assistant_thread_started", (payload) => {
      void this.intake.run(() => this.handleAssistantThreadStarted(payload));
    });
    this.socketClient.on("assistant_thread_context_changed", (payload) => {
      void this.intake.run(() => this.handleAgentContextChangedEvent(payload));
    });
    this.socketClient.on("app_context_changed", (payload) => {
      void this.intake.run(() => this.handleAgentContextChangedEvent(payload));
    });
    this.socketClient.on("block_actions", (payload) => {
      void this.intake.run(() => this.handleBlockAction(payload));
    });
    this.socketClient.on("interactive", (payload) => {
      void this.intake.run(() =>
        this.handleBlockAction(payload as { body: SlackBlockActionBody; ack: () => void }),
      );
    });
  }

  private async handleAppMention({
    event,
    ack,
  }: {
    event: unknown;
    ack: () => void;
  }): Promise<void> {
    const e = event as {
      text: string;
      channel: string;
      user: string;
      ts: string;
      thread_ts?: string;
      files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
    };

    if (e.channel.startsWith("D")) {
      ack();
      return;
    }

    const sessionKey = resolveSlackSessionKey(e.channel, e.thread_ts);

    const mentionText = this.stripOwnMention(e.text);
    const slackEvent = createConversationEvent({
      platform: "slack",
      conversationId: e.channel,
      type: "mention" as const,
      conversationKind: "shared",
      ts: e.ts,
      thread_ts: e.thread_ts,
      user: e.user,
      text: mentionText || "Please respond to the recent conversation context.",
      sessionKey,
      channel: e.channel,
      files: e.files,
    }) as SlackEvent;

    const attachmentsPromise = this.logUserMessage(slackEvent);

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

    const intake = this.processSlackMessageIntake({
      event: slackEvent,
      attachmentsPromise,
      queueKey: this.resolveQueueKey(e.channel, sessionKey),
      addressed: true,
    });

    ack();
    await intake;
  }

  private admitHumanMessage(
    event: SlackIncomingMessage,
    ack: () => void,
  ): event is SlackIncomingMessage & { user: string } {
    const hasSlackContent = hasMessageContent(event);
    const isOwnMessage =
      event.user === this.botUserId || (!!this.botId && event.bot_id === this.botId);
    if (isOwnMessage) {
      ack();
      return false;
    }

    const authorIsKnownHuman = !!event.user && this.users.get(event.user)?.isBot === false;
    const isExternalMessage =
      event.subtype === "bot_message" || (!!event.bot_id && !authorIsKnownHuman);
    if (isExternalMessage) {
      const supportedSubtype = BOT_MESSAGE_SUBTYPES.has(event.subtype);
      if (supportedSubtype && hasSlackContent) {
        void this.logExternalMessagingBotMessage(event).catch((err) => {
          log.logWarning("Failed to log Slack bot message", String(err));
        });
      }
      ack();
      return false;
    }

    const isSupportedUserMessage =
      !!event.user && USER_MESSAGE_SUBTYPES.has(event.subtype) && hasSlackContent;
    if (isSupportedUserMessage) return true;
    ack();
    return false;
  }

  private async deliverTaskUpdate(
    event: SlackEvent,
    attachmentsPromise: Promise<Attachment[]>,
  ): Promise<boolean> {
    if (matchMagicWord(event.text) === "stop" || event.text.startsWith("/")) return false;
    event.attachments = await attachmentsPromise;
    const context = this.createContext(event);
    const post = (text: string) =>
      event.thread_ts
        ? this.postInThread(event.channel, event.thread_ts, text)
        : this.postMessage(event.channel, text);
    try {
      const tasks = await context.responder.getTaskStatus!(
        event.thread_ts ? event.sessionKey : undefined,
      );
      if (!tasks.length) return false;
      const active = tasks.filter((t) => t.status === "running" || t.status === "stopping");
      const user = this.users.get(event.user);
      const intent: TaskIntent = event.attachments?.length
        ? event.thread_ts
          ? "steer"
          : "request"
        : await classifyTaskIntent(
            buildTaskIntentState(this.conversationDir(event.channel), event, {
              speaker: user?.displayName ?? user?.userName,
              tasks,
              resolveName: (id) => this.users.get(id)?.displayName ?? this.users.get(id)?.userName,
              botUserId: this.botUserId,
            }),
            event.text,
            { conversationId: event.channel, inTaskThread: !!event.thread_ts },
          );
      if (intent === "status") {
        const selection = event.thread_ts ? tasks : active.length ? active : tasks.slice(0, 1);
        const text =
          selection.length > 1
            ? "目前有多個任務在處理，請到你想查詢的任務對話串詢問，避免弄錯。"
            : formatTaskStatus(selection);
        const ts = await post(text);
        this.logBotResponse(event.channel, text, ts, event.thread_ts);
        return true;
      }
      if (intent === "steer") {
        const target = event.thread_ts
          ? context.message
          : active.length === 1
            ? {
                ...context.message,
                sessionKey: active[0]!.sessionKey,
                threadTs: active[0]!.threadTs,
              }
            : undefined;
        if (target && (await this.handler.steer?.(target))) {
          const text = "收到補充，會在下一個處理步驟納入；目前的操作不會立即中斷。";
          const ts = await post(text);
          this.logBotResponse(event.channel, text, ts, event.thread_ts);
          return true;
        }
      }
    } catch (error) {
      await post(error instanceof Error ? error.message : "Could not deliver task update.");
      return true;
    }
    return false;
  }

  private async evaluateJevAddressed(event: SlackEvent): Promise<boolean> {
    if (!event.text.trim() || matchMagicWord(event.text) === "stop") return false;

    try {
      const user = this.users.get(event.user);
      const state = buildAutoReplyState(this.conversationDir(event.channel), event, {
        speaker: user?.displayName ?? user?.userName,
        resolveName: (id) => this.users.get(id)?.displayName ?? this.users.get(id)?.userName,
        botUserId: this.botUserId,
      });
      const result = await evaluateWithJev(
        state,
        { addressed: { type: "boolean", instructions: JEV_ADDRESSED_INSTRUCTIONS } },
        { caller: "slack_auto_reply" },
      );
      const probability = result.answers.addressed.probability;
      log.logInfo(
        `[${event.channel}] jev auto-reply: probability=${probability.toFixed(2)} addressed=${probability > 0.5} text="${event.text.slice(0, 80)}"`,
      );
      return probability > 0.5;
    } catch (err) {
      if (err instanceof JevNotConfiguredError) {
        log.logWarning(
          "Slack auto-reply jev mode requires OPENROUTER_API_KEY; treating message as unaddressed",
          String(err),
        );
        return false;
      }
      reportUserFacingError(err, {
        domain: "chat_platform",
        surface: "slack_auto_reply_jev",
        operation: "evaluate",
        severity: "warning",
        context: { conversationId: event.address.conversationId },
      });
      return false;
    }
  }

  private async handleMessageEvent({
    event,
    ack,
  }: {
    event: unknown;
    ack: () => void;
  }): Promise<void> {
    const e = event as SlackIncomingMessage;
    if (!this.admitHumanMessage(e, ack)) return;

    const isDM = e.channel_type === "im" || e.channel.startsWith("D");
    const conversationKind: ConversationKind = isDM ? "direct" : "shared";
    const isMessagingBotMention = e.text?.includes(`<@${this.botUserId}>`);

    if (!isDM && isMessagingBotMention) {
      ack();
      return;
    }

    const sessionKey = isDM ? resolveSlackSessionKey(e.channel, e.thread_ts) : undefined;

    if (isDM && e.thread_ts && e.text) {
      void titleAssistantThread(
        this.assistantOps(),
        this.assistantThreads,
        e.channel,
        e.thread_ts,
        this.stripOwnMention(e.text),
      );
    }

    const slackEvent = createConversationEvent({
      platform: "slack",
      conversationId: e.channel,
      type: (isDM ? "dm" : "mention") as SlackEvent["type"],
      conversationKind,
      ts: e.ts,
      thread_ts: e.thread_ts,
      user: e.user,
      text: this.stripOwnMention(e.text),
      sessionKey,
      channel: e.channel,
      files: e.files,
    }) as SlackEvent;

    const attachmentsPromise = this.logUserMessage(slackEvent);

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

    const activeSessionKey =
      slackEvent.sessionKey ?? resolveSlackSessionKey(e.channel, e.thread_ts);
    slackEvent.sessionKey = activeSessionKey;
    const taskControl =
      isDM &&
      (e.thread_ts
        ? this.isTaskThread(e.channel, e.thread_ts)
        : this.hasRunningTaskThread(e.channel) || isTaskStatusQuestion(slackEvent.text));
    if (taskControl) {
      ack();
      if (await this.deliverTaskUpdate(slackEvent, attachmentsPromise)) return;
    }
    const autoReplyMode = isDM
      ? "off"
      : slackConversationAutoReplyMode(this.workspace.office(slackEvent.address));
    const autoReply =
      autoReplyMode === "on"
        ? true
        : autoReplyMode === "jev"
          ? await this.evaluateJevAddressed(slackEvent)
          : false;
    const intake = this.processSlackMessageIntake({
      event: slackEvent,
      attachmentsPromise,
      queueKey: this.resolveQueueKey(e.channel, activeSessionKey),
      addressed: isDM || autoReply,
      magicWordAddressed: isDM,
    });

    if (!taskControl) ack();
    await intake;
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
    const entry = COMMAND_MANIFEST.find((candidate) => candidate.slackCommand === command);
    if (!entry) return;

    if (!entry.slackRoute) return;
    try {
      await this.routeSlashCommand(entry.slackRoute, {
        command,
        text,
        channel_id,
        user_id,
        user_name,
        thread_ts,
      });
    } catch (err) {
      log.logWarning("Slack slash command error", err instanceof Error ? err.message : String(err));
    }
  }

  private handleAppHomeOpened({ event, ack }: { event: unknown; ack: () => void }): void {
    const e = event as { user: string; tab: string; channel?: string; context?: AgentContext };
    ack();

    if (e.tab === "messages") {
      if (e.channel) {
        void handleAgentDmOpened(this.assistantOps(), this.assistantThreads, e.channel, e.context);
      }
      return;
    }
    if (e.tab !== "home") return;

    this.webClient.views
      .publish({
        user_id: e.user,
        view: this.buildHomeView(e.channel),
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
    const sessionKey =
      action.value ?? action.action_id.replace("force_stop_", "").replace(/_/g, ":");
    const userId = body.user?.id;
    const channelId = body.container?.channel_id || conversationIdOf(sessionKey);

    log.logInfo(`[Force Stop] User ${userId} requested force stop for ${sessionKey}`);

    this.handler.forceStop(createOfficeAddress("slack", channelId), sessionKey);

    await this.postMessage(channelId, formatForceStopped("slack", userId ?? "unknown"));

    if (userId) {
      this.openDirectConversation(userId)
        .then((dmChannelId) =>
          this.webClient.views.publish({
            user_id: userId,
            view: this.buildHomeView(dmChannelId),
          }),
        )
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
    const threadTs = container.thread_ts;
    const sessionKey = resolveSlackSessionKey(channelId, threadTs);

    const selectedText = selectedOption?.text?.text ?? selectedOption?.value;
    const selectedTexts = selectedOptions?.map((option) => option.text?.text ?? option.value);
    const valueText = selectedTexts?.length
      ? selectedTexts.join(", ")
      : (selectedText ?? action.value ?? action.action_id);
    const text = `[Slack action] ${action.action_id}: ${valueText}`;
    const ts = `action:${Date.now()}`;

    this.logToFile(channelId, {
      date: new Date().toISOString(),
      ts,
      threadTs: threadTs || undefined,
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

    const event = createConversationEvent({
      platform: "slack",
      conversationId: channelId,
      type: "slack_action",
      conversationKind: channelId.startsWith("D") ? "direct" : "shared",
      ts,
      user: userId,
      text,
      attachments: [],
      thread_ts: threadTs || undefined,
      sessionKey,
    });

    this.getQueue(this.resolveQueueKey(channelId, sessionKey)).enqueue(async () => {
      const slackEvent: SlackEvent = {
        ...createConversationEvent({
          platform: "slack",
          conversationId: channelId,
          type: (event.conversationKind === "direct" ? "dm" : "mention") as SlackEvent["type"],
          conversationKind: event.conversationKind,
          ts,
          thread_ts: threadTs,
          user: userId,
          text,
          attachments: [],
          sessionKey,
        }),
        channel: channelId,
        attachments: [],
      };
      return this.handler.handleEvent(event, this, this.createContext(slackEvent));
    });
  }

  private async processAttachments(
    channelId: string,
    files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
    timestamp: string,
  ): Promise<Attachment[]> {
    const items = [];
    for (const file of files) {
      const url = file.url_private_download || file.url_private;
      if (!url) continue;
      if (!file.name) {
        throw new Error(`Attachment missing name for URL: ${url}`);
      }
      items.push({
        name: file.name,
        timestampMs: Math.floor(parseFloat(timestamp) * 1000),
        download: (destPath: string) => this.downloadSlackFile(url, destPath),
      });
    }

    const office = this.workspace.office(createOfficeAddress("slack", channelId));
    const { saved, failed } = await saveIncomingAttachments(office, items);
    const firstFailure = failed[0];
    if (firstFailure) {
      const { name, error } = firstFailure;
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to download attachment ${name}: ${errorMsg}`, { cause: error });
    }
    return saved;
  }

  private async downloadSlackFile(url: string, destPath: string): Promise<void> {
    await withRetry(
      async () => {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!response.ok) {
          throw new AttachmentDownloadHttpError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
          );
        }
        const buffer = await response.arrayBuffer();
        await writeFile(destPath, Buffer.from(buffer));
      },
      { maxAttempts: 3, baseDelayMs: 250, isRateLimited: isRetryableAttachmentDownloadError },
    );
  }

  private async logUserMessage(event: SlackEvent): Promise<Attachment[]> {
    const user = this.users.get(event.user);
    let attachments: Attachment[] = [];
    let attachmentError: unknown;
    if (event.files) {
      try {
        attachments = await this.processAttachments(event.channel, event.files, event.ts);
      } catch (err) {
        attachmentError = err;
      }
    }
    this.logToFile(event.channel, {
      date: new Date(parseFloat(event.ts) * 1000).toISOString(),
      ts: event.ts,
      threadTs: event.thread_ts,
      user: event.user,
      userName: user?.userName,
      displayName: user?.displayName,
      text: event.text,
      attachments,
      isMessagingBot: false,
    });
    if (attachmentError) throw attachmentError;
    return attachments;
  }

  private async logExternalMessagingBotMessage(event: {
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
      ? await this.processAttachments(event.channel, event.files, event.ts)
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
      isMessagingBot: true,
      botId: event.bot_id,
      appId: event.app_id ?? event.bot_profile?.app_id,
      subtype: event.subtype,
    });
    return attachments;
  }

  private async getExistingTimestamps(channelId: string): Promise<Set<string>> {
    const logPath = join(this.conversationDir(channelId), "log.jsonl");
    const timestamps = new Set<string>();
    if (!existsSync(logPath)) return timestamps;

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i] ?? "");
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

  private isBackfillableMessage(message: SlackHistoryMessage): boolean {
    if (message.user === this.botUserId) return true;
    if (hasBotIdentity(message)) {
      if (this.botId && message.bot_id === this.botId) return false;
      return BOT_MESSAGE_SUBTYPES.has(message.subtype) && hasMessageContent(message);
    }
    return (
      !!message.user &&
      USER_MESSAGE_SUBTYPES.has(message.subtype) &&
      hasMessageContent(message, false)
    );
  }

  private async backfillChannel(channelId: string, upperBoundTs?: string): Promise<number> {
    const existingTs = await this.getExistingTimestamps(channelId);

    let lastLoggedTs: string | undefined;
    for (const ts of existingTs) {
      if (!lastLoggedTs || parseFloat(ts) > parseFloat(lastLoggedTs)) lastLoggedTs = ts;
    }

    const allMessages: SlackHistoryMessage[] = [];

    let cursor: string | undefined;
    let pageCount = 0;
    const maxPages = 3;

    do {
      const result = await this.webClient.conversations.history({
        channel: channelId,
        oldest: lastLoggedTs,
        latest: upperBoundTs,
        inclusive: false,
        limit: 1000,
        cursor,
      });
      if (result.messages) {
        allMessages.push(...(result.messages as SlackHistoryMessage[]));
      }
      cursor = result.response_metadata?.next_cursor;
      pageCount++;
    } while (cursor && pageCount < maxPages);

    const relevantMessages = allMessages.filter((msg) => {
      if (!msg.ts || existingTs.has(msg.ts)) return false;
      return this.isBackfillableMessage(msg);
    });

    relevantMessages.reverse();

    for (const msg of relevantMessages) {
      const isMikanMessage = msg.user === this.botUserId;
      const isExternalMessagingBotMessage = !isMikanMessage && hasBotIdentity(msg);
      if (isExternalMessagingBotMessage) {
        await this.logExternalMessagingBotMessage({ ...msg, channel: channelId, ts: msg.ts! });
        continue;
      }

      const user = this.users.get(msg.user!);
      const text = this.stripOwnMention(msg.text);
      const attachments = msg.files
        ? await this.processAttachments(channelId, msg.files, msg.ts!)
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
        isMessagingBot: isMikanMessage,
      });
    }

    return relevantMessages.length;
  }

  private async backfillAllChannels(upperBoundTs?: string): Promise<void> {
    const startTime = Date.now();

    const channelsToBackfill: Array<[string, SlackChannel]> = [];
    for (const [channelId, channel] of this.channels) {
      const logPath = join(this.conversationDir(channelId), "log.jsonl");
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

      if (channelId !== channelsToBackfill[channelsToBackfill.length - 1]?.[0]) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const durationMs = Date.now() - startTime;
    log.logBackfillComplete(totalMessages, durationMs);
  }

  private async fetchUsers(): Promise<void> {
    let cursor: string | undefined;
    do {
      const result = await this.webClient.users.list({ limit: 200, cursor });
      const members = result.members as
        | Array<{
            id?: string;
            name?: string;
            real_name?: string;
            deleted?: boolean;
            is_bot?: boolean;
          }>
        | undefined;
      for (const u of members ?? []) {
        if (!u.id || !u.name || u.deleted) continue;
        this.users.set(u.id, {
          id: u.id,
          userName: u.name,
          displayName: u.real_name || u.name,
          isBot: !!u.is_bot,
        });
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }

  private async fetchChannels(): Promise<void> {
    let cursor: string | undefined;
    do {
      const result = await this.webClient.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const channels = result.channels as
        | Array<{
            id?: string;
            name?: string;
            is_member?: boolean;
            is_private?: boolean;
            is_shared?: boolean;
            is_ext_shared?: boolean;
          }>
        | undefined;
      for (const c of channels ?? []) {
        if (!c.id || !c.name || !c.is_member) continue;
        this.channels.set(c.id, {
          id: c.id,
          name: c.name,
          isPrivate: typeof c.is_private === "boolean" ? c.is_private : undefined,
          isExternallyShared: c.is_shared || c.is_ext_shared ? true : undefined,
        });
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);

    cursor = undefined;
    do {
      const result = await this.webClient.conversations.list({
        types: "im",
        limit: 200,
        cursor,
      });
      const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
      for (const im of ims ?? []) {
        if (!im.id) continue;
        const user = im.user ? this.users.get(im.user) : undefined;
        const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
        this.channels.set(im.id, { id: im.id, name });
      }
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
  }
}
