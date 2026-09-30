import { existsSync } from "node:fs";
import type {
  MessagingBot,
  MessagingEventHandler,
  MessagingInfo,
  ConversationEvent,
} from "../../types.js";
import * as log from "../../log.js";
import { resolveChatSessionKey } from "../../sessions/session-key.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  splitText,
} from "../shared.js";
import { matchMagicWord, processMessageIntake } from "../intake.js";
import { readGithubActivity } from "./activity.js";
import { GithubClient, GITHUB_MAX_COMMENT_LENGTH, githubRetry } from "./client.js";
import { createGithubAdapters } from "./context.js";
import { GithubOps } from "./github-ops.js";
import { permissionMeets, repoIsAllowed, userIsAllowed } from "./policy.js";
import {
  buildGithubConversationId,
  createConversationEvent,
  createOfficeAddress,
  parseGithubConversationId,
} from "../../office/index.js";
import type { Office, GithubConversationRef } from "../../office/types.js";
import { GITHUB_ISSUE_BODY_TS, githubReviewCommentTs, parseReviewCommentTs } from "./ids.js";
import type {
  GithubActivity,
  GithubAgentIdentity,
  GithubApi,
  GithubBotConfig,
  GithubCapability,
  GithubEvent,
  GithubIssue,
  GithubReactionContent,
  GithubReviewAnchor,
  GithubTrigger,
  GithubWebhookDelivery,
} from "./types.js";
import { errorMessage } from "../../unknown-values.js";

const PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;

const BODY_TRIGGER_WINDOW_MS = 10 * 60 * 1000;

export const formatGithubContinuation = (partNum: number): string => `*(continued ${partNum})*`;

const GITHUB_REACTIONS: Record<string, GithubReactionContent> = {
  "+1": "+1",
  thumbsup: "+1",
  "-1": "-1",
  thumbsdown: "-1",
  laugh: "laugh",
  smile: "laugh",
  confused: "confused",
  heart: "heart",
  hooray: "hooray",
  tada: "hooray",
  rocket: "rocket",
  eyes: "eyes",
  saluting_face: "eyes",
};

interface IncomingItem {
  ref: GithubConversationRef;
  ts: string;
  user: string;
  text: string;
  createdAt: string;
  addressed: boolean;
  review?: GithubReviewAnchor;
}

const MAX_DIFF_HUNK_CHARS = 1500;
const MAX_THREAD_TURNS = 10;
const MAX_THREAD_TURN_CHARS = 500;

function bodyTriggerNote(activity: GithubActivity): string | null {
  switch (activity.kind) {
    case "assigned":
      return `[Assigned to you by @${activity.sender.login}]`;
    case "review_requested":
      return `[Review requested by @${activity.sender.login}]`;
    case "opened":
    case "comment":
    case "review_comment":
      return null;
    default:
      return activity.kind satisfies never;
  }
}

export class GithubMessagingBot implements MessagingBot {
  private readonly client: GithubApi;
  private readonly handler: MessagingEventHandler;
  private readonly config: GithubBotConfig;
  readonly ops: GithubOps;
  private identity: GithubAgentIdentity | null = null;
  private queues = new Map<string, MessagingEventQueue>();
  private permissionCache = new Map<string, { allowed: boolean; expiresAt: number }>();
  private bodyTriggers = new Map<string, number>();
  private stopped = true;

  constructor(handler: MessagingEventHandler, config: GithubBotConfig, client?: GithubApi) {
    this.handler = handler;
    this.config = config;
    this.client = client ?? new GithubClient({ token: config.token });
    this.ops = new GithubOps(this.client);
  }

  get capabilities(): ReadonlySet<GithubCapability> {
    return this.config.policy.capabilities;
  }

  get agentIdentity(): GithubAgentIdentity | undefined {
    return this.identity ?? undefined;
  }

  async start(): Promise<void> {
    const user = await this.client.getAuthenticatedUser();
    this.identity = {
      login: user.login,
      email: `${user.id}+${user.login}@users.noreply.github.com`,
    };
    this.stopped = false;
    log.logConnected("GitHub");
    log.logInfo(
      `GitHub bot started as @${user.login}, answering in ${this.config.policy.repos.join(", ")}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const ref = parseGithubConversationId(channel);
    const parts = splitText(text, GITHUB_MAX_COMMENT_LENGTH, formatGithubContinuation);
    const firstId = await this.postComment(ref, parts[0] ?? text);
    for (const part of parts.slice(1)) {
      await this.postComment(ref, part);
    }
    return String(firstId);
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    const ref = parseGithubConversationId(channel);
    await githubRetry(() => this.client.updateIssueComment(ref.owner, ref.repo, Number(ts), text));
  }

  async addReaction(channel: string, messageTs: string, emoji: string): Promise<void> {
    const ref = parseGithubConversationId(channel);
    const content = GITHUB_REACTIONS[emoji.replace(/^:|:$/g, "")];
    if (!content) {
      throw new Error(
        `GitHub does not support reaction '${emoji}' (supported: ${Object.keys(GITHUB_REACTIONS).join(", ")})`,
      );
    }
    const reviewCommentId = parseReviewCommentTs(messageTs);
    await githubRetry(() => {
      if (messageTs === GITHUB_ISSUE_BODY_TS) {
        return this.client.createIssueReaction(ref.owner, ref.repo, ref.number, content);
      }
      if (reviewCommentId !== null) {
        return this.client.createReviewCommentReaction(
          ref.owner,
          ref.repo,
          reviewCommentId,
          content,
        );
      }
      return this.client.createCommentReaction(ref.owner, ref.repo, Number(messageTs), content);
    });
  }

  enqueueEvent(event: ConversationEvent): boolean {
    if (this.stopped) return false;
    return this.getQueue(event.address.conversationId).offerEvent(event, () => {
      const context = createGithubAdapters(event as GithubEvent, this);
      return this.handler.handleEvent(event, this, context);
    });
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "github",
      trustModel: "membership",
      formattingGuide:
        "## GitHub Formatting (GitHub Flavored Markdown)\n" +
        "Standard Markdown plus tables, task lists, fenced code blocks, and ```suggestion blocks.\n" +
        "Reference issues/PRs as #123 and users as @login (mentions notify people — use sparingly).",
      channels: [],
      users: [],
    };
  }

  async postComment(ref: GithubConversationRef, text: string): Promise<number> {
    const comment = await githubRetry(() =>
      this.client.createIssueComment(ref.owner, ref.repo, ref.number, text),
    );
    return comment.id;
  }

  async deleteComment(ref: GithubConversationRef, commentId: number): Promise<void> {
    await githubRetry(() => this.client.deleteIssueComment(ref.owner, ref.repo, commentId));
  }

  logToFile(conversationId: string, entry: object): void {
    appendChannelLog(this.office(conversationId), entry);
  }

  logBotResponse(conversationId: string, text: string, ts: string): void {
    appendBotResponseLog(this.office(conversationId), text, ts);
  }

  private getQueue(conversationId: string): MessagingEventQueue {
    let queue = this.queues.get(conversationId);
    if (!queue) {
      queue = new MessagingEventQueue("GitHub");
      this.queues.set(conversationId, queue);
    }
    return queue;
  }

  async receive(delivery: GithubWebhookDelivery): Promise<void> {
    if (this.stopped || !this.identity) return;
    const activity = readGithubActivity(delivery);
    if (!activity) return;
    try {
      await this.handleActivity(activity);
    } catch (err) {
      log.logWarning(
        `GitHub: failed to handle ${delivery.event} for ${activity.repo.owner}/${activity.repo.repo}#${activity.number}`,
        errorMessage(err),
      );
    }
  }

  private isAgent(login: string): boolean {
    return login.toLowerCase() === this.identity?.login.toLowerCase();
  }

  private triggerOf(activity: GithubActivity, conversationId: string): GithubTrigger | null {
    switch (activity.kind) {
      case "assigned":
        return activity.target !== null && this.isAgent(activity.target) ? "assign" : null;
      case "review_requested":
        return activity.target !== null && this.isAgent(activity.target) ? "review" : null;
      case "opened":
        return this.isMentioned(activity.text) ? "mention" : null;
      case "comment":
      case "review_comment":
        if (this.isMentioned(activity.text)) return "mention";
        return this.isParticipating(conversationId) ? "followup" : null;
      default:
        return activity.kind satisfies never;
    }
  }

  private claimBodyTrigger(conversationId: string): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of this.bodyTriggers) {
      if (expiresAt <= now) this.bodyTriggers.delete(key);
    }
    if (this.bodyTriggers.has(conversationId)) return false;
    this.bodyTriggers.set(conversationId, now + BODY_TRIGGER_WINDOW_MS);
    return true;
  }

  private async handleActivity(activity: GithubActivity): Promise<void> {
    const { policy } = this.config;
    if (activity.sender.isBot || this.isAgent(activity.sender.login)) return;
    if (!repoIsAllowed(policy, activity.repo)) return;
    const ref = { owner: activity.repo.owner, repo: activity.repo.repo, number: activity.number };
    const conversationId = buildGithubConversationId(ref);
    const trigger = this.triggerOf(activity, conversationId);
    if (trigger === null || !policy.triggers.has(trigger)) return;
    if (!userIsAllowed(policy, activity.sender.login)) {
      log.logInfo(
        `GitHub: ignoring ${conversationId} from ${activity.sender.login} (not in GITHUB_USERS)`,
      );
      return;
    }
    if (!(await this.hasTriggerPermission(ref, activity.sender.login))) {
      log.logInfo(
        `GitHub: ignoring ${conversationId} from ${activity.sender.login} (below ${policy.minPermission} permission)`,
      );
      return;
    }
    if (activity.ts === GITHUB_ISSUE_BODY_TS && !this.claimBodyTrigger(conversationId)) return;
    const note = bodyTriggerNote(activity);
    await this.handleIncoming({
      ref,
      ts: activity.ts,
      user: activity.sender.login,
      text: note ? `${note}\n\n${activity.text}` : activity.text,
      createdAt: activity.createdAt,
      addressed: trigger !== "followup",
      review: activity.review,
    });
  }

  private mentionPattern(): RegExp | null {
    const login = this.identity?.login;
    return login ? new RegExp(`@${login}(?![\\w-])`, "gi") : null;
  }

  private isMentioned(text: string): boolean {
    const pattern = this.mentionPattern();
    return pattern ? pattern.test(text) : false;
  }

  private stripMention(text: string): string {
    const pattern = this.mentionPattern();
    return (pattern ? text.replace(pattern, "") : text).trim();
  }

  private office(conversationId: string): Office {
    return this.config.workspace.office(createOfficeAddress("github", conversationId));
  }

  private isParticipating(conversationId: string): boolean {
    return existsSync(this.office(conversationId).logPath);
  }

  private async hasTriggerPermission(ref: GithubConversationRef, user: string): Promise<boolean> {
    const cacheKey = `${ref.owner}/${ref.repo}#${user.toLowerCase()}`;
    const cached = this.permissionCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.allowed;
    let allowed: boolean;
    try {
      const role = await githubRetry(() =>
        this.client.getCollaboratorPermission(ref.owner, ref.repo, user),
      );
      allowed = permissionMeets(this.config.policy, role);
    } catch (err) {
      log.logWarning(
        `GitHub: permission lookup failed for ${user} on ${ref.owner}/${ref.repo}; denying trigger`,
        errorMessage(err),
      );
      return false;
    }
    this.permissionCache.set(cacheKey, {
      allowed,
      expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
    });
    return allowed;
  }

  private async handleIncoming(item: IncomingItem): Promise<void> {
    const conversationId = buildGithubConversationId(item.ref);
    const participating = this.isParticipating(conversationId);
    const cleanedText = this.stripMention(item.text);
    const sessionKey = resolveChatSessionKey({
      conversationId,
      conversationKind: "shared",
      messageId: item.ts,
      persistentTopLevel: true,
    });

    const messageText = item.review
      ? await this.formatReviewMessage(item.ref, item.review, cleanedText)
      : cleanedText;

    const eventBase = createConversationEvent({
      platform: "github",
      type: item.ts === GITHUB_ISSUE_BODY_TS ? "issue" : "message",
      conversationId,
      conversationKind: "shared",
      ts: item.ts,
      sessionKey,
      user: item.user,
      userName: item.user,
      text: messageText,
    }) as GithubEvent;

    await processMessageIntake({
      eventBase,
      addressed: true,
      magicWord: { text: cleanedText, addressed: item.addressed, scopeFallback: "never" },
      busyPolicy: "queue",
      logEntryBase: {
        date: item.createdAt,
        ts: item.ts,
        user: item.user,
        userName: item.user,
        text: messageText,
        isMessagingBot: false,
      },
      log: (entry) => {
        if (!participating && matchMagicWord(cleanedText) === "stop") return;
        this.logToFile(conversationId, entry);
      },
      processAttachments: async () => {
        if (!participating && item.ts !== GITHUB_ISSUE_BODY_TS) {
          await this.logIssueContext(item.ref, conversationId, item.createdAt);
        }
        return [];
      },
      queueKey: conversationId,
      enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
      handler: this.handler,
      bot: this,
      createContext: (event) => createGithubAdapters(event, this),
    });
  }

  private async formatReviewMessage(
    ref: IncomingItem["ref"],
    review: GithubReviewAnchor,
    cleanedText: string,
  ): Promise<string> {
    const location = review.line !== null ? `${review.path}:${review.line}` : review.path;
    const parts = [`[PR review comment ${githubReviewCommentTs(review.commentId)} on ${location}]`];
    if (review.diffHunk) {
      const hunk =
        review.diffHunk.length > MAX_DIFF_HUNK_CHARS
          ? `…${review.diffHunk.slice(-MAX_DIFF_HUNK_CHARS)}`
          : review.diffHunk;
      parts.push(`\`\`\`diff\n${hunk}\n\`\`\``);
    }
    if (review.inReplyToId !== undefined) {
      const turns = await this.reviewThreadContext(ref, review.inReplyToId, review.commentId);
      if (turns.length > 0) {
        parts.push(`Thread so far:\n${turns.join("\n")}`);
      }
    }
    parts.push(cleanedText);
    return parts.join("\n");
  }

  private async reviewThreadContext(
    ref: GithubConversationRef,
    rootId: number,
    beforeId: number,
  ): Promise<string[]> {
    try {
      const all = await githubRetry(() =>
        this.client.listPullReviewComments(ref.owner, ref.repo, ref.number),
      );
      return all
        .filter(
          (comment) =>
            (comment.id === rootId || comment.in_reply_to_id === rootId) && comment.id < beforeId,
        )
        .slice(-MAX_THREAD_TURNS)
        .map((comment) => {
          const body =
            comment.body.length > MAX_THREAD_TURN_CHARS
              ? `${comment.body.slice(0, MAX_THREAD_TURN_CHARS)}…`
              : comment.body;
          return `@${comment.user.login}: ${body}`;
        });
    } catch (err) {
      log.logWarning(
        `GitHub: could not fetch review thread context for ${ref.owner}/${ref.repo}#${ref.number}`,
        errorMessage(err),
      );
      return [];
    }
  }

  private async logIssueContext(
    ref: GithubConversationRef,
    conversationId: string,
    triggerCreatedAt: string,
  ): Promise<void> {
    let issue: GithubIssue;
    try {
      issue = await githubRetry(() => this.client.getIssue(ref.owner, ref.repo, ref.number));
    } catch (err) {
      log.logWarning(
        `GitHub: could not fetch issue context for ${conversationId}`,
        errorMessage(err),
      );
      return;
    }
    const triggerMs = Date.parse(triggerCreatedAt);
    const contextDate = new Date((Number.isFinite(triggerMs) ? triggerMs : Date.now()) - 1000);
    this.logToFile(conversationId, {
      date: contextDate.toISOString(),
      ts: GITHUB_ISSUE_BODY_TS,
      user: issue.user.login,
      userName: issue.user.login,
      text: `# ${issue.title}\n\n${issue.body ?? ""}`.trim(),
      attachments: [],
      isMessagingBot: false,
    });
  }
}
