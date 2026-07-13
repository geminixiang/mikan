import { existsSync } from "fs";
import { dirname, join } from "path";
import { Type } from "@sinclair/typebox";
import type {
  ConversationEvent,
  MessagingBot,
  MessagingEventHandler,
  MessagingInfo,
} from "../../adapter.js";
import type {
  GithubCheckSummary,
  GithubIssueRequest,
  GithubPrRequest,
  GithubPrResult,
  GithubReadRequest,
  GithubReadResult,
} from "./types.js";
import * as log from "../../log.js";
import { ensureDirExists, readJsonSchemaFileIfExists } from "../../utils/file-guards.js";
import { atomicWritePrivateFile } from "../../utils/fs-atomic.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  splitText,
  withRetry,
} from "../shared.js";
import { processMessageIntake } from "../intake.js";
import { GithubApiError, GithubClient, githubIsRateLimited } from "./client.js";
import {
  CLOUD_BUILD_APP_SLUG,
  CloudBuildLogUnavailableError,
  fetchCloudBuildLog,
  isCloudBuildId,
  projectFromDetailsUrl,
} from "./cloudbuild.js";
import { createGithubAdapters } from "./context.js";
import { cloneRepo, GITHUB_PUSH_BRANCH_PATTERN, pushBranch, syncRepo } from "./repo.js";
import {
  buildGithubConversationId,
  GITHUB_ISSUE_BODY_TS,
  githubReviewCommentTs,
  parseGithubConversationId,
  parseReviewCommentTs,
} from "./ids.js";
import type {
  GithubBotConfig,
  GithubConversationRef,
  GithubEvent,
  GithubIssue,
  GithubReactionContent,
  GithubRepoRef,
  GithubSyncState,
} from "./types.js";

const SyncStateSchema = Type.Object({
  repos: Type.Record(
    Type.String(),
    Type.Object({
      baseline: Type.String(),
      cursor: Type.String(),
      seenComments: Type.Array(Type.Number()),
      seenIssues: Type.Array(Type.Number()),
      // Optional: state files written before review-comment polling must keep
      // loading — a schema failure re-baselines and silently drops dedup state.
      seenReviewComments: Type.Optional(Type.Array(Type.Number())),
    }),
  ),
});

/**
 * Re-fetch this far behind the cursor each poll. Dedup is by id (the
 * watermark), so the overlap only costs bandwidth and closes the boundary
 * races of a bare `since` timestamp (DESIGN.md § Event source).
 */
const POLL_OVERLAP_MS = 5 * 60 * 1000;

const MAX_SEEN_IDS = 5000;

/** Effective role → rank, for the trigger-permission gate. */
const PERMISSION_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

/**
 * Commenters need write or better to trigger the agent. Fixed, not a config
 * knob: it guards public repos (anyone can comment there), and the people who
 * ask an agent to change code are exactly the people with push access.
 */
const REQUIRED_TRIGGER_RANK = PERMISSION_RANK.write;

/** Permission lookups are cached this long per repo+user. */
const PERMISSION_CACHE_TTL_MS = 5 * 60 * 1000;

/** In-memory form of one repo's persisted watermark. */
interface RepoWatermark {
  baseline: string;
  cursor: string;
  seenComments: Set<number>;
  seenIssues: Set<number>;
  seenReviewComments: Set<number>;
}

const githubRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { isRateLimited: githubIsRateLimited });

/** GitHub comment bodies cap at 65536 chars; leave headroom for markup. */
export const GITHUB_MAX_COMMENT_LENGTH = 60000;

export const formatGithubContinuation = (partNum: number): string => `*(continued ${partNum})*`;

/** Slack-style emoji short names → GitHub reaction content values. */
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
};

interface IncomingItem {
  ref: GithubConversationRef;
  /** Comment id, rc-<id> for review comments, or GITHUB_ISSUE_BODY_TS for the body. */
  ts: string;
  user: string;
  text: string;
  createdAt: string;
  /** Known only for issue-body items; comment first-contact resolves it via getIssue. */
  isPr?: boolean;
  /** Present for inline PR review comments: the diff anchor to inject as context. */
  review?: {
    commentId: number;
    path: string;
    line: number | null;
    diffHunk: string;
    inReplyToId?: number;
  };
}

// Repo refs are lowercased at every entry point (env config here, the
// installation API in start()) so conversation ids and sync-state keys never
// depend on how a repo's name was spelled — GitHub is case-insensitive.
function parseRepoList(repos: string[]): GithubRepoRef[] {
  return repos.map((entry) => {
    const [owner, repo, ...rest] = entry.split("/");
    if (!owner || !repo || rest.length > 0) {
      throw new Error(`Invalid GITHUB_REPOS entry (expected owner/repo): ${entry}`);
    }
    return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
  });
}

/** Sets iterate in insertion order; drop the oldest ids once over the cap. */
function pruneSeen(seen: Set<number>): void {
  if (seen.size <= MAX_SEEN_IDS) return;
  let toDrop = seen.size - MAX_SEEN_IDS / 2;
  for (const id of seen) {
    if (toDrop-- <= 0) break;
    seen.delete(id);
  }
}

/** Issue number from a comment's `issue_url` (…/repos/o/r/issues/42). */
function issueNumberFromUrl(issueUrl: string): number {
  const match = /\/issues\/(\d+)$/.exec(issueUrl);
  if (!match) {
    throw new Error(`Cannot parse issue number from ${issueUrl}`);
  }
  return Number(match[1]);
}

/** PR number from a review comment's `pull_request_url` (…/repos/o/r/pulls/42). */
function prNumberFromUrl(pullRequestUrl: string): number {
  const match = /\/pulls\/(\d+)$/.exec(pullRequestUrl);
  if (!match) {
    throw new Error(`Cannot parse PR number from ${pullRequestUrl}`);
  }
  return Number(match[1]);
}

/** Keep the tail: a review comment anchors to the hunk's final lines. */
const MAX_DIFF_HUNK_CHARS = 1500;
const MAX_THREAD_TURNS = 10;
const MAX_THREAD_TURN_CHARS = 500;

export class GithubMessagingBot implements MessagingBot {
  private readonly client: GithubClient;
  private readonly handler: MessagingEventHandler;
  private readonly config: GithubBotConfig;
  private appSlug: string | null = null;
  private botEmail: string | null = null;
  private watchedRepos: GithubRepoRef[] = [];
  private queues = new Map<string, MessagingEventQueue>();
  private repoState = new Map<string, RepoWatermark>();
  private permissionCache = new Map<string, { rank: number; expiresAt: number }>();
  /** Cloud Build ids seen in getChecks summaries → their GCP project. */
  private buildRef = new Map<string, { project: string }>();
  private pollInFlight = false;

  constructor(handler: MessagingEventHandler, config: GithubBotConfig, client?: GithubClient) {
    this.handler = handler;
    this.config = config;
    this.client =
      client ??
      new GithubClient({
        appId: config.appId,
        privateKey: config.privateKey,
        installationId: config.installationId,
      });
  }

  // ==========================================================================
  // Public API (implements MessagingBot)
  // ==========================================================================

  async start(): Promise<void> {
    this.appSlug = await this.client.getAppSlug();
    // Canonical noreply author email (<user-id>+<login>@users.noreply.github.com)
    // so the bot's commits link to its avatar/profile; degrade to a plain
    // noreply spelling when the lookup fails.
    try {
      const botUserId = await this.client.getUserId(`${this.appSlug}[bot]`);
      this.botEmail = `${botUserId}+${this.appSlug}[bot]@users.noreply.github.com`;
    } catch {
      this.botEmail = `${this.appSlug}[bot]@users.noreply.github.com`;
    }
    this.watchedRepos =
      this.config.repos.length > 0
        ? parseRepoList(this.config.repos)
        : (await this.client.listInstallationRepositories()).map((repository) => ({
            owner: repository.owner.login.toLowerCase(),
            repo: repository.name.toLowerCase(),
          }));
    if (this.watchedRepos.length === 0) {
      log.logWarning("GitHub: installation has no repositories; nothing to poll");
    }

    // Restore persisted watermarks; a repo watched for the first time gets a
    // baseline of "now" so history never triggers (DESIGN.md § Event source).
    const persisted = this.loadSyncState();
    const now = new Date().toISOString();
    for (const repo of this.watchedRepos) {
      const repoKey = `${repo.owner}/${repo.repo}`;
      const saved = persisted?.repos[repoKey];
      this.repoState.set(
        repoKey,
        saved
          ? {
              baseline: saved.baseline,
              cursor: saved.cursor,
              seenComments: new Set(saved.seenComments),
              seenIssues: new Set(saved.seenIssues),
              seenReviewComments: new Set(saved.seenReviewComments ?? []),
            }
          : {
              baseline: now,
              cursor: now,
              seenComments: new Set(),
              seenIssues: new Set(),
              seenReviewComments: new Set(),
            },
      );
    }
    this.persistSyncState();

    setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs).unref();

    log.logConnected("GitHub");
    log.logInfo(
      `GitHub bot started as @${this.appSlug}[bot], polling ${this.watchedRepos.length} repo(s) every ${Math.round(this.config.pollIntervalMs / 1000)}s`,
    );
  }

  async postMessage(channel: string, text: string): Promise<string> {
    const ref = parseGithubConversationId(channel);
    const parts = splitText(text, GITHUB_MAX_COMMENT_LENGTH, formatGithubContinuation);
    const firstId = await this.postComment(ref, parts[0]);
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
      const context = createGithubAdapters(event as GithubEvent, this);
      return this.handler.handleEvent(event, this, context);
    });
    return true;
  }

  getMessagingInfo(): MessagingInfo {
    return {
      name: "github",
      trustModel: "open-trigger",
      formattingGuide:
        "## GitHub Formatting (GitHub Flavored Markdown)\n" +
        "Standard Markdown plus tables, task lists, and ```suggestion blocks.\n" +
        "Reference issues/PRs as #123 and users as @login.",
      channels: [],
      users: [],
    };
  }

  // ==========================================================================
  // Internal helpers (used by context.ts)
  // ==========================================================================

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
    appendChannelLog(this.config.workingDir, conversationId, entry);
  }

  logBotResponse(conversationId: string, text: string, ts: string): void {
    appendBotResponseLog(this.config.workingDir, conversationId, text, ts);
  }

  // ==========================================================================
  // Private - polling
  // ==========================================================================

  private getQueue(conversationId: string): MessagingEventQueue {
    let queue = this.queues.get(conversationId);
    if (!queue) {
      queue = new MessagingEventQueue("GitHub");
      this.queues.set(conversationId, queue);
    }
    return queue;
  }

  /** One poll tick over every watched repo. Public for tests. */
  async poll(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      let changed = false;
      for (const repo of this.watchedRepos) {
        try {
          changed = (await this.pollRepo(repo)) || changed;
        } catch (err) {
          log.logWarning(
            `GitHub poll failed for ${repo.owner}/${repo.repo}`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (changed) {
        this.persistSyncState();
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  private async pollRepo(repo: GithubRepoRef): Promise<boolean> {
    const repoKey = `${repo.owner}/${repo.repo}`;
    const state = this.repoState.get(repoKey);
    if (!state) return false;
    const since = new Date(Date.parse(state.cursor) - POLL_OVERLAP_MS).toISOString();
    let changed = false;

    // Comment activity also bumps the parent issue's updated_at, so the issues
    // list mostly echoes the comments list; only issues *created* since the
    // baseline are new conversations (their body is the first message).
    const issues = (await this.client.listIssuesSince(repo.owner, repo.repo, since)) ?? [];
    for (const issue of issues) {
      if (issue.updated_at > state.cursor) {
        state.cursor = issue.updated_at;
        changed = true;
      }
      // Edits re-surface old items with a fresh updated_at; the id watermark
      // plus the creation baseline decide what actually triggers.
      if (issue.created_at < state.baseline || state.seenIssues.has(issue.id)) continue;
      state.seenIssues.add(issue.id);
      changed = true;
      if (issue.user.type === "Bot") continue;
      await this.handleIncoming({
        ref: { ...repo, number: issue.number },
        ts: GITHUB_ISSUE_BODY_TS,
        user: issue.user.login,
        text: `# ${issue.title}\n\n${issue.body ?? ""}`.trim(),
        createdAt: issue.created_at,
        isPr: Boolean(issue.pull_request),
      });
    }

    const comments = (await this.client.listIssueCommentsSince(repo.owner, repo.repo, since)) ?? [];
    for (const comment of comments) {
      if (comment.updated_at > state.cursor) {
        state.cursor = comment.updated_at;
        changed = true;
      }
      if (comment.created_at < state.baseline || state.seenComments.has(comment.id)) continue;
      state.seenComments.add(comment.id);
      changed = true;
      if (comment.user.type === "Bot") continue;
      await this.handleIncoming({
        ref: { ...repo, number: issueNumberFromUrl(comment.issue_url) },
        ts: String(comment.id),
        user: comment.user.login,
        text: comment.body,
        createdAt: comment.created_at,
      });
    }

    // Inline PR review comments live in their own endpoint and id space; the
    // same watermark discipline applies. The bot's own thread replies (the
    // github_review_reply tool) re-surface here and are dropped as Bot-authored.
    const reviewComments =
      (await this.client.listPullReviewCommentsSince(repo.owner, repo.repo, since)) ?? [];
    for (const comment of reviewComments) {
      if (comment.updated_at > state.cursor) {
        state.cursor = comment.updated_at;
        changed = true;
      }
      if (comment.created_at < state.baseline || state.seenReviewComments.has(comment.id)) {
        continue;
      }
      state.seenReviewComments.add(comment.id);
      changed = true;
      if (comment.user.type === "Bot") continue;
      await this.handleIncoming({
        ref: { ...repo, number: prNumberFromUrl(comment.pull_request_url) },
        ts: githubReviewCommentTs(comment.id),
        user: comment.user.login,
        text: comment.body,
        createdAt: comment.created_at,
        isPr: true,
        review: {
          commentId: comment.id,
          path: comment.path,
          line: comment.line,
          diffHunk: comment.diff_hunk,
          inReplyToId: comment.in_reply_to_id,
        },
      });
    }

    pruneSeen(state.seenComments);
    pruneSeen(state.seenIssues);
    pruneSeen(state.seenReviewComments);
    return changed;
  }

  // ==========================================================================
  // Private - watermark persistence
  // ==========================================================================

  private loadSyncState(): GithubSyncState | undefined {
    try {
      return readJsonSchemaFileIfExists(
        this.config.syncStatePath,
        SyncStateSchema,
        (detail) => `Malformed GitHub sync state at ${this.config.syncStatePath}: ${detail}`,
      );
    } catch (err) {
      // A bad state file re-baselines (history won't trigger) rather than
      // blocking startup; the next persist overwrites it.
      log.logWarning(
        "GitHub: ignoring unreadable sync state",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private persistSyncState(): void {
    const state: GithubSyncState = { repos: {} };
    for (const [repoKey, watermark] of this.repoState) {
      state.repos[repoKey] = {
        baseline: watermark.baseline,
        cursor: watermark.cursor,
        seenComments: [...watermark.seenComments],
        seenIssues: [...watermark.seenIssues],
        seenReviewComments: [...watermark.seenReviewComments],
      };
    }
    ensureDirExists(dirname(this.config.syncStatePath));
    atomicWritePrivateFile(this.config.syncStatePath, JSON.stringify(state));
  }

  // ==========================================================================
  // Private - triggering
  // ==========================================================================

  /** Fresh regex per call: the `g` flag makes `test`/`replace` stateful. */
  private mentionPattern(): RegExp | null {
    return this.appSlug ? new RegExp(`@${this.appSlug}(?![\\w-])`, "gi") : null;
  }

  private isMentioned(text: string): boolean {
    const pattern = this.mentionPattern();
    return pattern ? pattern.test(text) : false;
  }

  private stripMention(text: string): string {
    const pattern = this.mentionPattern();
    return (pattern ? text.replace(pattern, "") : text).trim();
  }

  private isParticipating(conversationId: string): boolean {
    return existsSync(join(this.config.workingDir, conversationId, "log.jsonl"));
  }

  /**
   * True when `user` holds at least write permission on the repo. Fails
   * closed: a failed lookup denies the trigger (and logs) rather than
   * letting an unverified commenter drive the agent.
   */
  private async hasTriggerPermission(ref: GithubConversationRef, user: string): Promise<boolean> {
    const cacheKey = `${ref.owner}/${ref.repo}#${user}`;
    const cached = this.permissionCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.rank >= REQUIRED_TRIGGER_RANK;
    }
    let rank: number;
    try {
      const role = await githubRetry(() =>
        this.client.getCollaboratorPermission(ref.owner, ref.repo, user),
      );
      // Custom role_name values are unrankable; the legacy permission field
      // still carries their closest standard mapping, so take the stronger.
      rank = Math.max(
        PERMISSION_RANK[role.role_name ?? ""] ?? 0,
        PERMISSION_RANK[role.permission] ?? 0,
      );
    } catch (err) {
      log.logWarning(
        `GitHub: permission lookup failed for ${user} on ${ref.owner}/${ref.repo}; denying trigger`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
    this.permissionCache.set(cacheKey, {
      rank,
      expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
    });
    return rank >= REQUIRED_TRIGGER_RANK;
  }

  private async handleIncoming(item: IncomingItem): Promise<void> {
    const conversationId = buildGithubConversationId(item.ref);
    const mentioned = this.isMentioned(item.text);
    const participating = this.isParticipating(conversationId);
    // Narrow trigger (DESIGN.md): only threads the bot is mentioned in or
    // already participates in. Everything else is ignored without logging so
    // busy repos don't grow conversation dirs for untouched issues.
    if (!mentioned && !participating) return;

    // Permission gate: on public repos anyone can comment, so a mention from
    // anyone below write permission is ignored entirely (no log, no state).
    if (!(await this.hasTriggerPermission(item.ref, item.user))) {
      log.logInfo(
        `GitHub: ignoring ${conversationId} comment from ${item.user} (below write permission)`,
      );
      return;
    }

    const cleanedText = this.stripMention(item.text);
    const sessionKey = resolveChatSessionKey({
      conversationId,
      conversationKind: "shared",
      messageId: item.ts,
      persistentTopLevel: true,
    });

    const messageText = item.review
      ? await this.formatReviewMessage(item, cleanedText)
      : cleanedText;

    const eventBase: GithubEvent = {
      type: item.ts === GITHUB_ISSUE_BODY_TS ? "issue" : "message",
      conversationId,
      conversationKind: "shared",
      ts: item.ts,
      sessionKey,
      user: item.user,
      userName: item.user,
      text: messageText,
    };

    await processMessageIntake({
      eventBase,
      workingDir: this.config.workingDir,
      isAutoReplyCandidate: false,
      // Match on the user-typed text, not the review-decorated messageText.
      magicWord: { text: cleanedText, addressed: mentioned, scopeFallback: "never" },
      busyPolicy: "queue",
      logEntryBase: {
        date: item.createdAt,
        ts: item.ts,
        user: item.user,
        userName: item.user,
        text: messageText,
        isMessagingBot: false,
      },
      log: (entry) => this.logToFile(conversationId, entry),
      // GitHub has no attachments; the prep hook is used to lay down the
      // issue context and repo clone only for messages that will dispatch,
      // and before the comment itself is logged.
      processAttachments: async () => {
        await this.prepareConversation(item, conversationId, participating);
        return [];
      },
      queueKey: conversationId,
      enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
      handler: this.handler,
      bot: this,
      createContext: (event) => createGithubAdapters(event, this),
    });
  }

  /**
   * First contact: log the issue title/body ahead of the comment so the
   * session history starts with what the thread is about. The clone is
   * (re)attempted on every trigger while ./repo is missing — a no-op once
   * it exists — so a failed first clone (e.g. App permissions granted
   * later) heals on the next mention instead of wedging the conversation.
   */
  private async prepareConversation(
    item: IncomingItem,
    conversationId: string,
    participating: boolean,
  ): Promise<void> {
    let isPrHint = item.isPr;
    if (!participating && item.ts !== GITHUB_ISSUE_BODY_TS) {
      const issue = await this.logIssueContext(item.ref, conversationId, item.createdAt);
      // Only comments arrive without the PR-ness hint; review comments carry
      // isPr: true (they only exist on PRs) and that knowledge is authoritative.
      if (issue && isPrHint === undefined) isPrHint = Boolean(issue.pull_request);
    }
    if (!existsSync(this.repoDir(conversationId))) {
      const isPr = isPrHint ?? (await this.fetchIsPr(item.ref));
      await this.ensureRepoClone(item.ref, conversationId, isPr);
    }
  }

  /**
   * Decorates an inline review comment with its diff anchor and (for replies)
   * the thread's earlier turns, so the agent knows which code the feedback is
   * about without hunting through the PR. The rc-<id> in the header is what
   * github_review_reply takes to answer in-thread.
   */
  private async formatReviewMessage(item: IncomingItem, cleanedText: string): Promise<string> {
    const review = item.review!;
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
      const turns = await this.reviewThreadContext(item.ref, review.inReplyToId, review.commentId);
      if (turns.length > 0) {
        parts.push(`Thread so far:\n${turns.join("\n")}`);
      }
    }
    parts.push(cleanedText);
    return parts.join("\n");
  }

  /**
   * Earlier turns of one review thread (root + replies before the trigger),
   * newest-truncated. Fail-soft: context is a nicety, the trigger is not.
   */
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
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private async logIssueContext(
    ref: GithubConversationRef,
    conversationId: string,
    triggerCreatedAt: string,
  ): Promise<GithubIssue | null> {
    let issue: GithubIssue;
    try {
      issue = await githubRetry(() => this.client.getIssue(ref.owner, ref.repo, ref.number));
    } catch (err) {
      log.logWarning(
        `GitHub: could not fetch issue context for ${conversationId}`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
    // Dated just before the triggering comment, NOT issue.created_at: history
    // sync date-sorts entries and drops anything older than its recency
    // window, so an old issue's real creation date would silently evict the
    // one message that says what the thread is about.
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
    return issue;
  }

  // ==========================================================================
  // Repo clone + pull requests
  // ==========================================================================

  private repoDir(conversationId: string): string {
    return join(this.config.workingDir, conversationId, "repo");
  }

  /** Whether the conversation's issue is a PR, for clone retries where the
   *  triggering item didn't carry that knowledge. Errs toward plain issue. */
  private async fetchIsPr(ref: GithubConversationRef): Promise<boolean> {
    try {
      const issue = await githubRetry(() => this.client.getIssue(ref.owner, ref.repo, ref.number));
      return Boolean(issue.pull_request);
    } catch {
      return false;
    }
  }

  /**
   * The PR's head branch name when it lives in this repo — that is the name
   * the local checkout should carry, so committing on it and calling
   * github_pr pushes back to the PR itself instead of opening a new one.
   * Fork heads (unpushable with the repo-scoped token) and failed lookups
   * return undefined; callers then fall back to the synthetic pr-<n>.
   */
  private async fetchPrHeadBranch(ref: GithubConversationRef): Promise<string | undefined> {
    try {
      const pr = await githubRetry(() =>
        this.client.getPullRequest(ref.owner, ref.repo, ref.number),
      );
      const sameRepo =
        pr.head?.repo?.full_name?.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase();
      return sameRepo ? pr.head?.ref : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Clone the conversation's repo into its dir (bind-mounted into the
   * sandbox) using an ephemeral contents:read token that never leaves the
   * host. Non-fatal: a failed clone degrades to the pre-clone experience.
   */
  private async ensureRepoClone(
    ref: GithubConversationRef,
    conversationId: string,
    isPr: boolean,
  ): Promise<void> {
    const dir = this.repoDir(conversationId);
    if (existsSync(dir)) return;
    try {
      const token = await this.client.createScopedInstallationToken(ref.repo, {
        contents: "read",
      });
      const prHeadBranch = isPr ? await this.fetchPrHeadBranch(ref) : undefined;
      await cloneRepo({
        url: `https://github.com/${ref.owner}/${ref.repo}.git`,
        dir,
        token,
        botLogin: `${this.appSlug}[bot]`,
        botEmail: this.botEmail ?? `${this.appSlug}[bot]@users.noreply.github.com`,
        prNumber: isPr ? ref.number : undefined,
        prHeadBranch,
      });
      log.logInfo(
        `[${conversationId}] Cloned ${ref.owner}/${ref.repo}${isPr ? ` and checked out PR #${ref.number} head as ${prHeadBranch ?? `pr-${ref.number}`}` : ""}`,
      );
    } catch (err) {
      log.logWarning(
        `GitHub: repo clone failed for ${conversationId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Backs the `github_pr` tool: push a `pi/*` branch the agent prepared in
   * the conversation's clone, then open a pull request as the App. The write
   * token is minted per call, scoped to this one repo, and never enters the
   * sandbox.
   */
  async pushAndCreatePr(conversationId: string, request: GithubPrRequest): Promise<GithubPrResult> {
    const ref = parseGithubConversationId(conversationId);
    const dir = this.repoDir(conversationId);
    if (!existsSync(dir)) {
      throw new Error("This conversation has no ./repo clone to push from.");
    }
    if (!GITHUB_PUSH_BRANCH_PATTERN.test(request.branch)) {
      throw new Error(
        `Branch '${request.branch}' is not pushable: name it pi/<something> (e.g. pi/fix-${ref.number}).`,
      );
    }
    const repository = await githubRetry(() => this.client.getRepository(ref.owner, ref.repo));
    const base = request.base ?? repository.default_branch;
    const token = await this.client.createScopedInstallationToken(ref.repo, {
      contents: "write",
      pull_requests: "write",
    });
    await pushBranch({ dir, branch: request.branch, token });
    try {
      const pr = await githubRetry(() =>
        this.client.createPullRequest(ref.owner, ref.repo, {
          title: request.title,
          head: request.branch,
          base,
          body: request.body,
          draft: request.draft,
        }),
      );
      log.logInfo(`[${conversationId}] Opened PR #${pr.number}: ${pr.html_url}`);
      return { number: pr.number, url: pr.html_url };
    } catch (err) {
      // Idempotency: pushing more commits to a branch that already has an
      // open PR updates that PR; the create call then 422s. Surface the
      // existing PR instead of failing the fix-CI-push-again loop.
      if (
        err instanceof GithubApiError &&
        err.status === 422 &&
        /already exists/i.test(err.message)
      ) {
        const existing = await this.client.findOpenPullRequestByBranch(
          ref.owner,
          ref.repo,
          request.branch,
        );
        if (existing) {
          log.logInfo(
            `[${conversationId}] Pushed to existing PR #${existing.number}: ${existing.html_url}`,
          );
          return { number: existing.number, url: existing.html_url, updatedExisting: true };
        }
      }
      throw err;
    }
  }

  /**
   * Backs the `github_checks` tool: CI check runs for a branch the agent
   * pushed, or for the conversation's PR head when no branch is given.
   */
  async getChecks(conversationId: string, branch?: string): Promise<GithubCheckSummary[]> {
    const ref = parseGithubConversationId(conversationId);
    let target = branch;
    if (!target) {
      let pr;
      try {
        pr = await githubRetry(() => this.client.getPullRequest(ref.owner, ref.repo, ref.number));
      } catch {
        pr = null;
      }
      if (!pr?.head) {
        throw new Error(
          "This conversation is not a pull request — pass the branch whose checks you want.",
        );
      }
      target = pr.head.sha;
    }
    const runs = await githubRetry(() => this.client.listCheckRuns(ref.owner, ref.repo, target));
    return runs.map((run) => {
      const externalId = run.external_id?.trim() || null;
      let buildLogAvailable = false;
      // Cloud Build runs carry their build UUID in external_id and the GCP
      // project in details_url. Remember project-by-build so getBuildLog only
      // serves builds the agent actually saw on this repo's checks.
      if (
        this.config.cloudBuild &&
        run.app?.slug === CLOUD_BUILD_APP_SLUG &&
        externalId &&
        isCloudBuildId(externalId)
      ) {
        const project =
          projectFromDetailsUrl(run.details_url) ?? this.config.cloudBuild.projectFallback;
        if (project) {
          this.rememberBuild(externalId, project);
          buildLogAvailable = true;
        }
      }
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
        appSlug: run.app?.slug ?? null,
        outputSummary: run.output?.summary?.trim() ? run.output.summary.slice(0, 500) : null,
        externalId,
        buildLogAvailable,
      };
    });
  }

  private rememberBuild(buildId: string, project: string): void {
    // Insertion-ordered Map as a small LRU: re-insert on touch, prune oldest.
    this.buildRef.delete(buildId);
    this.buildRef.set(buildId, { project });
    if (this.buildRef.size > 200) {
      const oldest = this.buildRef.keys().next().value;
      if (oldest !== undefined) this.buildRef.delete(oldest);
    }
  }

  /**
   * Backs the Cloud Build log mode of `github_checks`. GCP credentials stay
   * host-side (ADC via GOOGLE_APPLICATION_CREDENTIALS — e.g. a Workload
   * Identity Federation external_account file); the build must have appeared
   * in a github_checks summary first, which is also where its project is
   * learned. Unreadable logs degrade to the console url, never a dead end.
   */
  async getBuildLog(conversationId: string, buildId: string): Promise<string> {
    if (!this.config.cloudBuild) {
      throw new Error(
        "Cloud Build log access is not configured on this host (no GCP credentials).",
      );
    }
    const known = this.buildRef.get(buildId);
    if (!known) {
      throw new Error(
        `Unknown build id ${buildId}: run github_checks first and take a [build …] id from ` +
          `the summary.`,
      );
    }
    let logText: string;
    try {
      logText = await fetchCloudBuildLog({
        tokenProvider: this.config.cloudBuild.tokenProvider,
        project: known.project,
        buildId,
      });
    } catch (err) {
      if (err instanceof CloudBuildLogUnavailableError) {
        throw new Error(
          `${err.message}${err.consoleUrl ? ` Console: ${err.consoleUrl}` : ""} Use the check's ` +
            `summary/url from github_checks, or reproduce the failure locally in ./repo.`,
          { cause: err },
        );
      }
      throw err;
    }
    const MAX_LOG_CHARS = 20000;
    return logText.length > MAX_LOG_CHARS
      ? `…(truncated to the last ${MAX_LOG_CHARS} chars)\n${logText.slice(-MAX_LOG_CHARS)}`
      : logText;
  }

  /**
   * Backs the `github_sync` tool: refresh the conversation's ./repo clone
   * from origin with an ephemeral read token. Fetch-only when moving the
   * checkout could lose agent work; the formatted report tells the agent
   * what happened and what to do next.
   */
  async syncRepo(conversationId: string, branch?: string): Promise<string> {
    const ref = parseGithubConversationId(conversationId);
    const dir = this.repoDir(conversationId);
    if (!existsSync(dir)) {
      throw new Error("This conversation has no ./repo clone to sync.");
    }
    const token = await this.client.createScopedInstallationToken(ref.repo, {
      contents: "read",
    });
    let prNumber: number | undefined;
    let prHeadBranch: string | undefined;
    let defaultBranch: string | undefined;
    if (!branch) {
      if (await this.fetchIsPr(ref)) {
        prNumber = ref.number;
        prHeadBranch = await this.fetchPrHeadBranch(ref);
      } else {
        const repository = await githubRetry(() => this.client.getRepository(ref.owner, ref.repo));
        defaultBranch = repository.default_branch;
      }
    }
    const result = await syncRepo({ dir, token, branch, prNumber, prHeadBranch, defaultBranch });

    if (result.updatedCheckout) {
      return `Updated ./repo: branch ${result.target} is now at ${result.fetchedSha.slice(0, 12)}.`;
    }
    const reasons: string[] = [];
    if (result.currentBranch !== result.target) {
      reasons.push(`the checkout is on '${result.currentBranch}', not '${result.target}'`);
    }
    if (result.dirty) {
      reasons.push("the working tree has uncommitted changes");
    }
    if (result.localCommits > 0) {
      reasons.push(`'${result.target}' has ${result.localCommits} local commit(s) not on origin`);
    }
    return (
      `Fetched ${result.target} to FETCH_HEAD (${result.fetchedSha.slice(0, 12)}) but left the ` +
      `checkout alone: ${reasons.join("; ")}. Merge or rebase FETCH_HEAD yourself ` +
      `(e.g. git merge FETCH_HEAD), or commit your work to a pi/* branch first.`
    );
  }

  /**
   * Backs the `github_read` tool: PR/issue metadata the ./repo clone cannot
   * provide (diff stats, review state, other issues in the repo). Owner/repo
   * always come from the conversation id, so reads never leave this repo.
   */
  async readGithub(conversationId: string, request: GithubReadRequest): Promise<GithubReadResult> {
    const ref = parseGithubConversationId(conversationId);
    const number = request.number ?? ref.number;
    switch (request.action) {
      case "pr": {
        const pr = await githubRetry(() => this.client.getPullRequest(ref.owner, ref.repo, number));
        return { kind: "pr", pr };
      }
      case "pr_files": {
        const files = await githubRetry(() =>
          this.client.listPullRequestFiles(ref.owner, ref.repo, number),
        );
        return { kind: "pr_files", files };
      }
      case "pr_reviews": {
        const [reviews, threads] = await Promise.all([
          githubRetry(() => this.client.listPullRequestReviews(ref.owner, ref.repo, number)),
          githubRetry(() => this.client.listPullReviewComments(ref.owner, ref.repo, number)),
        ]);
        return { kind: "pr_reviews", reviews, threads };
      }
      case "issue": {
        const issue = await githubRetry(() => this.client.getIssue(ref.owner, ref.repo, number));
        return { kind: "issue", issue };
      }
      case "comments": {
        const comments = await githubRetry(() =>
          this.client.listIssueComments(ref.owner, ref.repo, number),
        );
        return { kind: "comments", comments };
      }
      case "list": {
        const issues = await githubRetry(() =>
          this.client.listIssues(ref.owner, ref.repo, {
            state: request.state,
            labels: request.labels,
            creator: request.creator,
          }),
        );
        return { kind: "list", issues };
      }
      default:
        throw new Error(`Unknown github_read action: ${String(request.action)}`);
    }
  }

  /**
   * Backs the `github_issue` tool: labels, assignees, and open/closed state
   * on any issue of this conversation's repo (triage). Same-repo by
   * construction — owner/repo come from the conversation id; the action enum
   * is closed, so lock/delete/transfer cannot be expressed at all.
   */
  async manageIssue(conversationId: string, request: GithubIssueRequest): Promise<string> {
    const ref = parseGithubConversationId(conversationId);
    const number = request.number ?? ref.number;
    try {
      switch (request.action) {
        case "add_labels": {
          if (!request.labels?.length) {
            throw new Error("add_labels requires a non-empty labels array.");
          }
          await githubRetry(() =>
            this.client.addIssueLabels(ref.owner, ref.repo, number, request.labels!),
          );
          return `Added label(s) ${request.labels.join(", ")} to #${number}.`;
        }
        case "remove_label": {
          if (!request.label) {
            throw new Error("remove_label requires a label name.");
          }
          await githubRetry(() =>
            this.client.removeIssueLabel(ref.owner, ref.repo, number, request.label!),
          );
          return `Removed label ${request.label} from #${number}.`;
        }
        case "add_assignees": {
          if (!request.assignees?.length) {
            throw new Error("add_assignees requires a non-empty assignees array.");
          }
          await githubRetry(() =>
            this.client.addIssueAssignees(ref.owner, ref.repo, number, request.assignees!),
          );
          return `Assigned ${request.assignees.map((login) => `@${login}`).join(", ")} to #${number}.`;
        }
        case "remove_assignees": {
          if (!request.assignees?.length) {
            throw new Error("remove_assignees requires a non-empty assignees array.");
          }
          await githubRetry(() =>
            this.client.removeIssueAssignees(ref.owner, ref.repo, number, request.assignees!),
          );
          return `Unassigned ${request.assignees.map((login) => `@${login}`).join(", ")} from #${number}.`;
        }
        case "close": {
          await githubRetry(() =>
            this.client.updateIssueState(
              ref.owner,
              ref.repo,
              number,
              "closed",
              request.state_reason,
            ),
          );
          return `Closed #${number}${request.state_reason ? ` as ${request.state_reason}` : ""}.`;
        }
        case "reopen": {
          await githubRetry(() =>
            this.client.updateIssueState(ref.owner, ref.repo, number, "open"),
          );
          return `Reopened #${number}.`;
        }
        default:
          throw new Error(`Unknown github_issue action: ${String(request.action)}`);
      }
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        throw new Error(`Issue #${number} not found in ${ref.owner}/${ref.repo}.`, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Backs the `github_review_reply` tool: answer inside one inline review
   * thread of this conversation's PR. The comment id comes from an
   * `[PR review comment rc-<id> …]` message; GitHub validates it belongs to
   * this PR (404 otherwise, translated into agent-actionable guidance).
   */
  async replyToReviewThread(
    conversationId: string,
    commentId: number,
    body: string,
  ): Promise<{ url: string }> {
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error(
        "comment_id must be the numeric id from an [PR review comment rc-<id> …] message.",
      );
    }
    const ref = parseGithubConversationId(conversationId);
    const text =
      body.length > GITHUB_MAX_COMMENT_LENGTH
        ? `${body.slice(0, GITHUB_MAX_COMMENT_LENGTH)}\n…(truncated)`
        : body;
    try {
      const reply = await githubRetry(() =>
        this.client.replyToReviewComment(ref.owner, ref.repo, ref.number, commentId, text),
      );
      return {
        url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}#discussion_r${reply.id}`,
      };
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        throw new Error(
          `Comment ${commentId} is not a review comment on this PR. Take the id from an ` +
            `[PR review comment rc-<id> …] message in this conversation; do not guess ids.`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Backs the log mode of `github_checks`: the tail of one CI job's log so
   * the agent can diagnose a failing check without sandbox credentials. Only
   * GitHub Actions checks have logs on GitHub — external CI apps (e.g. Cloud
   * Build) keep theirs on their own service, so a 404 here is translated
   * into guidance instead of a dead end.
   */
  async getJobLog(conversationId: string, jobId: number): Promise<string> {
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new Error(
        "job_id must be a positive Actions job id taken from a [job …] entry in the github_checks summary.",
      );
    }
    const ref = parseGithubConversationId(conversationId);
    let logText: string;
    try {
      logText = await githubRetry(() => this.client.getJobLog(ref.owner, ref.repo, jobId));
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        throw new Error(
          `No GitHub Actions log for job ${jobId}. Logs are only available for checks reported ` +
            `by github-actions; external CI (e.g. Cloud Build) keeps logs on its own service — ` +
            `use that check's summary/url from github_checks, or reproduce the failure locally ` +
            `in ./repo instead. Do not retry with other ids.`,
          { cause: err },
        );
      }
      throw err;
    }
    const MAX_LOG_CHARS = 20000;
    return logText.length > MAX_LOG_CHARS
      ? `…(truncated to the last ${MAX_LOG_CHARS} chars)\n${logText.slice(-MAX_LOG_CHARS)}`
      : logText;
  }
}
