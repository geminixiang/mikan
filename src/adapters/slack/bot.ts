import { SocketModeClient } from "@slack/socket-mode";
import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
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
import { COMMAND_MANIFEST, type SlackSlashRoute } from "../../commands/manifest.js";
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
import { PRODUCT_NAME, formatForceStopped } from "../../platform-messages.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  withRetry,
} from "../shared.js";
import { processMessageIntake } from "../intake.js";
import { createSlackAdapters } from "./context.js";
import {
  hasMaterializedChatSession,
  registerThreadSession,
} from "../../sessions/chat-history-sync.js";
import { conversationIdOf, scopeSessionIdentity } from "../../sessions/session-key.js";
import type { ConversationStorageManager } from "../../sessions/conversation-storage-manager.js";
import type { ResolvedConversationStorage } from "../../sessions/types.js";
import {
  isSlackThreadSessionKey,
  planSlackAdapterSession,
  planSlackEventAnchorRun,
  resolveSlackSessionKey,
} from "./session.js";
import { reportUserFacingError } from "../../observability/sentry.js";
import { renderSlackBlocks } from "./blocks.js";

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
  private readonly storageManager?: ConversationStorageManager;
  private botUserId: string | null = null;
  private botId: string | null = null;
  private teamId: string | null = null;
  private ownMentionRegex: RegExp | null = null;
  private startupTs: string | null = null; // Messages older than this are just logged, not processed

  private users = new Map<string, SlackUser>();
  private channels = new Map<string, SlackChannel>();
  private queues = new Map<string, MessagingEventQueue>();
  private eventsWatcher: EventsWatcher | null = null;

  private storageId(conversationId: string): string {
    return (
      this.storageManager?.requireResolved("slack", conversationId).storageKey ?? conversationId
    );
  }

  private storageKey(conversationId: string): string {
    return this.storageManager?.storageKey("slack", conversationId) ?? conversationId;
  }

  private async resolveStorage(
    conversationId: string,
  ): Promise<ResolvedConversationStorage | undefined> {
    return this.storageManager?.resolve("slack", conversationId);
  }

  private scopeEvent(event: ConversationEvent): ConversationEvent {
    if (!this.storageManager) return event;
    const storage = this.storageManager.requireResolved("slack", event.conversationId);
    const platformSessionKey = event.sessionKey ?? event.conversationId;
    return {
      ...event,
      storageKey: storage.storageKey,
      conversationDir: storage.conversationDir,
      runtimeSessionKey: scopeSessionIdentity(
        platformSessionKey,
        event.conversationId,
        storage.storageKey,
      ).runtimeSessionKey,
    };
  }

  private createContext(event: SlackEvent): ConversationContext {
    const conversationDir =
      this.storageManager?.requireResolved("slack", event.conversationId).conversationDir ??
      join(this.workingDir, event.conversationId);
    return createSlackAdapters(event, this, {
      replyMode: resolveConversationSettings(conversationDir).slack?.replyMode ?? "top-level",
    });
  }

  constructor(
    handler: MessagingEventHandler,
    config: {
      appToken: string;
      botToken: string;
      workingDir: string;
      store: ChannelStore;
      storageManager?: ConversationStorageManager;
    },
  ) {
    this.handler = handler;
    this.workingDir = config.workingDir;
    this.store = config.store;
    this.storageManager = config.storageManager;
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
      const payload = { channel, ...renderSlackBlocks(text) };
      const result = await this.webClient.chat.postMessage(payload);
      return result.ts as string;
    });
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    // Slack reaction names are colon-free short names; strip any wrapping colons.
    const name = emoji.replace(/^:|:$/g, "");
    await slackRetry(async () => {
      try {
        await this.webClient.reactions.add({ channel, timestamp: messageTs, name });
      } catch (err) {
        // Re-reacting with the same emoji is not an error worth surfacing.
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
    appendChannelLog(this.workingDir, this.storageId(channel), entry);
  }

  logBotResponse(
    channel: string,
    text: string,
    ts: string,
    threadTs?: string,
    slackBlocks?: object[],
  ): void {
    appendBotResponseLog(this.workingDir, this.storageId(channel), text, ts, threadTs, {
      platform: "slack",
      ...(slackBlocks ? { slackBlocks } : {}),
    });
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "slack",
      trustModel: "membership",
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
    const queueKey = this.storageManager?.storageKey("slack", conversationId) ?? conversationId;
    const queue = this.getQueue(queueKey);
    if (queue.size() >= 5) {
      log.logWarning(
        `Event queue full for ${conversationId}, discarding: ${event.text.substring(0, 50)}`,
      );
      return false;
    }
    log.logInfo(`Enqueueing event for ${conversationId}: ${event.text.substring(0, 50)}`);
    queue.enqueue(async () => {
      const storage = await this.storageManager?.resolve("slack", conversationId);
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
          conversationDir: storage?.conversationDir ?? join(this.workingDir, conversationId),
          sessionKey: eventForRun.sessionKey,
        });
      }

      const platformRunQueueKey = planSlackAdapterSession(eventForRun, {
        initialMessageTs: eventPlan.initialMessageTs,
      }).sessionKey;
      const runQueueKey = storage
        ? scopeSessionIdentity(platformRunQueueKey, conversationId, storage.storageKey)
            .runtimeSessionKey
        : platformRunQueueKey;
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
        const scopedEvent = storage
          ? {
              ...eventForRun,
              storageKey: storage.storageKey,
              conversationDir: storage.conversationDir,
              runtimeSessionKey: scopeSessionIdentity(
                eventForRun.sessionKey ?? conversationId,
                conversationId,
                storage.storageKey,
              ).runtimeSessionKey,
            }
          : eventForRun;
        const context = createSlackAdapters(slackEvent, this, {
          initialMessageTs: eventPlan.initialMessageTs,
          replyMode:
            resolveConversationSettings(
              storage?.conversationDir ?? join(this.workingDir, conversationId),
            ).slack?.replyMode ?? "top-level",
        });
        return this.handler.handleEvent(scopedEvent, this, context);
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

  private resolvePlatformQueueKey(conversationId: string, sessionKey: string): string {
    if (!isSlackThreadSessionKey(sessionKey)) return sessionKey;
    const runtimeSessionKey = this.storageManager
      ? scopeSessionIdentity(
          sessionKey,
          conversationId,
          this.storageManager.storageKey("slack", conversationId),
        ).runtimeSessionKey
      : sessionKey;
    if (this.handler.isRunning(runtimeSessionKey)) return sessionKey;
    return this.hasKnownThreadSession(conversationId, sessionKey) ? sessionKey : conversationId;
  }

  private resolveQueueKey(conversationId: string, sessionKey: string): string {
    const platformQueueKey = this.resolvePlatformQueueKey(conversationId, sessionKey);
    return this.storageManager
      ? scopeSessionIdentity(
          platformQueueKey,
          conversationId,
          this.storageManager.storageKey("slack", conversationId),
        ).runtimeSessionKey
      : platformQueueKey;
  }

  private hasKnownThreadSession(conversationId: string, sessionKey: string): boolean {
    return hasMaterializedChatSession({
      conversationDir: join(this.workingDir, this.storageKey(conversationId)),
      sessionKey,
    });
  }

  private processSlackMessageIntake(options: {
    event: SlackEvent;
    attachmentsPromise: Promise<Attachment[]>;
    queueKey: string;
    isAutoReplyCandidate: boolean;
    addressed: boolean;
  }): void {
    const absorbAttachmentFailure = () => {
      void options.attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
    };
    processMessageIntake({
      eventBase: options.event as unknown as ConversationEvent,
      workingDir: this.workingDir,
      isAutoReplyCandidate: options.isAutoReplyCandidate,
      magicWord: { addressed: options.addressed, scopeFallback: "top-level" },
      busyPolicy: "queue",
      logEntryBase: {},
      processAttachments: () => options.attachmentsPromise,
      queueKey: options.queueKey,
      enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
      handler: this.handler,
      bot: this,
      createContext: (event) => this.createContext(event as SlackEvent),
      deferAttachmentsUntilRun: true,
      resolveStorage: this.storageManager
        ? () => this.storageManager!.resolve("slack", options.event.conversationId)
        : undefined,
    }).then(
      (outcome) => {
        // Slack logs eagerly via logUserMessage; when intake does not enqueue,
        // nothing awaits the attachment download, so absorb its failure here.
        if (outcome !== "enqueued") absorbAttachmentFailure();
      },
      (err) => {
        log.logWarning("Slack message intake failed", String(err));
        absorbAttachmentFailure();
      },
    );
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
        const channelId = session.conversationId ?? conversationIdOf(session.sessionKey);
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
                // The raw session key travels in `value` (Slack returns it
                // verbatim); the action_id only routes and must be unique per
                // view, so it carries a sanitized copy of the key. Never
                // decode the key from the action_id — the `:`↔`_` rewrite is
                // irreversible for conversation ids that contain `_` (GitHub's
                // GH_owner_repo_number do, by design).
                action_id: `force_stop_${session.sessionKey.replace(/:/g, "_")}`,
                value: session.sessionKey,
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

  /**
   * Generic slash-command route: synthesize the command text per the
   * manifest's SlackSlashRoute data and dispatch to the handler. `/pi-new`
   * stays bespoke (routeSlashNewCommand) because it replies in 中文 and calls
   * handleNewCommand directly.
   */
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
    await this.resolveStorage(payload.channel_id);
    const { event, context } = this.buildSlashCommandEvent(payload, {
      includeText: route.includeText,
      thread: route.thread,
      ...(route.privateCommand
        ? {
            type: payload.channel_id.startsWith("D")
              ? ("dm" as const)
              : ("private_command" as const),
          }
        : {}),
    });
    await this.handler.handleEvent(this.scopeEvent(event), this, context);
  }

  private async routeSlashNewCommand(payload: {
    command: string;
    channel_id: string;
    user_id: string;
    user_name?: string;
  }): Promise<void> {
    const conversationId = payload.channel_id;
    await this.resolveStorage(conversationId);
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
    const storage = await this.resolveStorage(conversationId);
    const runtimeSessionKey = storage
      ? scopeSessionIdentity(conversationId, conversationId, storage.storageKey).runtimeSessionKey
      : conversationId;
    if (storage) {
      await this.handler.handleNewCommand(runtimeSessionKey, conversationId, commandMessagingBot, {
        platformSessionKey: conversationId,
        storageKey: storage.storageKey,
        conversationDir: storage.conversationDir,
      });
    } else {
      await this.handler.handleNewCommand(runtimeSessionKey, conversationId, commandMessagingBot);
    }
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

    this.processSlackMessageIntake({
      event: slackEvent,
      attachmentsPromise,
      queueKey: this.resolvePlatformQueueKey(e.channel, sessionKey),
      isAutoReplyCandidate: false,
      addressed: true,
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

    // API posts made with a user token carry the posting app's bot_id/app_id
    // alongside the human `user` — bot_id alone does not make the author a
    // bot. Only treat the message as bot-authored when the author is not a
    // known human user (bot users have is_bot=true; unknown authors stay on
    // the conservative bot path so loop protection holds).
    const authorIsKnownHuman = !!e.user && this.users.get(e.user)?.isBot === false;
    const isExternalMessagingBotMessage =
      e.subtype === "bot_message" || (!!e.bot_id && !authorIsKnownHuman);
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

    // message.im normally carries channel_type "im", but fall back to the
    // D-prefix convention (used by handleAppMention and session keys) so a
    // missing channel_type cannot silently demote a DM to an auto-reply
    // candidate that never triggers.
    const isDM = e.channel_type === "im" || e.channel.startsWith("D");
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

    if (!isDM && isThreadReply) {
      void attachmentsPromise.catch((err) => {
        log.logWarning("Failed to log Slack message", String(err));
      });
      ack();
      return;
    }

    const activeSessionKey =
      slackEvent.sessionKey ?? resolveSlackSessionKey(e.channel, e.thread_ts);
    // Auto-reply top-level channel messages start with no sessionKey because
    // they are only candidates until the policy allows them. Persist the
    // resolved key on the event; otherwise the runtime fallback treats the
    // message ts as a thread session (`channel:ts`) instead of the persistent
    // top-level channel session.
    slackEvent.sessionKey = activeSessionKey;
    this.processSlackMessageIntake({
      event: slackEvent,
      attachmentsPromise,
      queueKey: this.resolvePlatformQueueKey(e.channel, activeSessionKey),
      isAutoReplyCandidate: !isDM,
      addressed: isDM,
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
    const entry = COMMAND_MANIFEST.find((candidate) => candidate.slackCommand === command);
    if (!entry) return;

    let handlerPromise: Promise<void> | null = null;
    if (entry.name === "new") {
      handlerPromise = this.routeSlashNewCommand({ command, channel_id, user_id, user_name });
    } else if (entry.slackRoute) {
      handlerPromise = this.routeSlashCommand(entry.slackRoute, {
        command,
        text,
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
      void this.handleSlackInteraction(body, action).catch((err) => {
        log.logWarning("Slack interaction storage resolution failed", String(err));
      });
      return;
    }

    ack();
    // Prefer the verbatim key from `value`; the action_id fallback only
    // serves buttons rendered before `value` existed and misdecodes session
    // keys whose conversation id contains "_".
    const sessionKey =
      action.value ?? action.action_id.replace("force_stop_", "").replace(/_/g, ":");
    const userId = body.user?.id;
    const runtimeSession = this.handler
      .getRunningSessions()
      .find((session) => session.sessionKey === sessionKey);
    const channelId =
      body.container?.channel_id ?? runtimeSession?.conversationId ?? conversationIdOf(sessionKey);

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

  private async handleSlackInteraction(
    body: SlackBlockActionBody,
    action: SlackBlockAction,
  ): Promise<void> {
    const container = body.container ?? {};
    const channelId = container.channel_id;
    const userId = body.user?.id;
    if (!channelId || !userId) return;
    await this.resolveStorage(channelId);

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
      return this.handler.handleEvent(this.scopeEvent(event), this, this.createContext(slackEvent));
    });
  }

  /**
   * Log a user message to log.jsonl after attachments are ready.
   */
  private async logUserMessage(event: SlackEvent): Promise<Attachment[]> {
    await this.resolveStorage(event.channel);
    const storageId = this.storageId(event.channel);
    const user = this.users.get(event.user);
    let attachments: Attachment[] = [];
    let attachmentError: unknown;
    if (event.files) {
      try {
        attachments = await this.store.processAttachments(storageId, event.files, event.ts);
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
    await this.resolveStorage(event.channel);
    const storageId = this.storageId(event.channel);
    const attachments = event.files
      ? await this.store.processAttachments(storageId, event.files, event.ts)
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

  // ==========================================================================
  // Private - Backfill
  // ==========================================================================

  private async getExistingTimestamps(channelId: string): Promise<Set<string>> {
    await this.resolveStorage(channelId);
    const logPath = join(this.workingDir, this.storageId(channelId), "log.jsonl");
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
      const isExternalMessagingBotMessage = !!msg.bot_id || msg.subtype === "bot_message";
      if (isExternalMessagingBotMessage) {
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
      const isExternalMessagingBotMessage =
        !isMikanMessage && (!!msg.bot_id || msg.subtype === "bot_message");
      if (isExternalMessagingBotMessage) {
        await this.logExternalMessagingBotMessage({ ...msg, channel: channelId, ts: msg.ts! });
        continue;
      }

      const user = this.users.get(msg.user!);
      const text = this.stripOwnMention(msg.text);
      const storageId = this.storageId(channelId);
      const attachments = msg.files
        ? await this.store.processAttachments(storageId, msg.files, msg.ts!)
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

    // Only backfill channels that already have a log.jsonl (mikan has interacted with them before)
    const channelsToBackfill: Array<[string, SlackChannel]> = [];
    for (const [channelId, channel] of this.channels) {
      const logPath = join(this.workingDir, this.storageKey(channelId), "log.jsonl");
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
        | Array<{
            id?: string;
            name?: string;
            real_name?: string;
            deleted?: boolean;
            is_bot?: boolean;
          }>
        | undefined;
      if (members) {
        for (const u of members) {
          if (u.id && u.name && !u.deleted) {
            this.users.set(u.id, {
              id: u.id,
              userName: u.name,
              displayName: u.real_name || u.name,
              isBot: !!u.is_bot,
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
