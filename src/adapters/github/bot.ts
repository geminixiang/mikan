import { existsSync } from "fs";
import { dirname, join } from "path";
import { Type } from "@sinclair/typebox";
import type {
  ConversationEvent,
  MessagingBot,
  MessagingEventHandler,
  MessagingInfo,
} from "../../adapter.js";
import * as log from "../../log.js";
import { ensureDirExists, readJsonSchemaFileIfExists } from "../../utils/file-guards.js";
import { atomicWritePrivateFile } from "../../utils/fs-atomic.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import { formatNothingRunning } from "../../platform-messages.js";
import {
  appendBotResponseLog,
  appendChannelLog,
  MessagingEventQueue,
  resolveStopTarget,
  splitText,
  withRetry,
} from "../shared.js";
import { processMessageIntake } from "../intake.js";
import { GithubClient, githubIsRateLimited } from "./client.js";
import { createGithubAdapters } from "./context.js";
import {
  buildGithubConversationId,
  GITHUB_ISSUE_BODY_TS,
  parseGithubConversationId,
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

/** In-memory form of one repo's persisted watermark. */
interface RepoWatermark {
  baseline: string;
  cursor: string;
  seenComments: Set<number>;
  seenIssues: Set<number>;
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
  /** Comment id, or GITHUB_ISSUE_BODY_TS for the issue/PR body itself. */
  ts: string;
  user: string;
  text: string;
  createdAt: string;
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

export class GithubMessagingBot implements MessagingBot {
  private readonly client: GithubClient;
  private readonly handler: MessagingEventHandler;
  private readonly config: GithubBotConfig;
  private appSlug: string | null = null;
  private watchedRepos: GithubRepoRef[] = [];
  private queues = new Map<string, MessagingEventQueue>();
  private repoState = new Map<string, RepoWatermark>();
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
            }
          : { baseline: now, cursor: now, seenComments: new Set(), seenIssues: new Set() },
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
    await githubRetry(() =>
      messageTs === GITHUB_ISSUE_BODY_TS
        ? this.client.createIssueReaction(ref.owner, ref.repo, ref.number, content)
        : this.client.createCommentReaction(ref.owner, ref.repo, Number(messageTs), content),
    );
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

    pruneSeen(state.seenComments);
    pruneSeen(state.seenIssues);
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

  private async handleIncoming(item: IncomingItem): Promise<void> {
    const conversationId = buildGithubConversationId(item.ref);
    const mentioned = this.isMentioned(item.text);
    const participating = this.isParticipating(conversationId);
    // Narrow trigger (DESIGN.md): only threads the bot is mentioned in or
    // already participates in. Everything else is ignored without logging so
    // busy repos don't grow conversation dirs for untouched issues.
    if (!mentioned && !participating) return;

    const cleanedText = this.stripMention(item.text);
    const sessionKey = resolveChatSessionKey({
      conversationId,
      conversationKind: "shared",
      messageId: item.ts,
      persistentTopLevel: true,
    });

    if (/^stop$/i.test(cleanedText)) {
      this.logToFile(conversationId, {
        date: item.createdAt,
        ts: item.ts,
        user: item.user,
        userName: item.user,
        text: cleanedText,
        attachments: [],
        isMessagingBot: false,
      });
      const stopTarget = resolveStopTarget({ handler: this.handler, conversationId, sessionKey });
      if (stopTarget) {
        await this.handler.handleStop(stopTarget, conversationId, this);
      } else if (mentioned) {
        await this.postMessage(conversationId, formatNothingRunning("github"));
      }
      return;
    }

    // First contact via a comment: log the issue title/body first so the
    // session history starts with what the thread is about.
    if (!participating && item.ts !== GITHUB_ISSUE_BODY_TS) {
      await this.logIssueContext(item.ref, conversationId, item.createdAt);
    }

    const eventBase: GithubEvent = {
      type: item.ts === GITHUB_ISSUE_BODY_TS ? "issue" : "message",
      conversationId,
      conversationKind: "shared",
      ts: item.ts,
      sessionKey,
      user: item.user,
      userName: item.user,
      text: cleanedText,
    };

    await processMessageIntake({
      eventBase,
      workingDir: this.config.workingDir,
      isAutoReplyCandidate: false,
      logEntryBase: {
        date: item.createdAt,
        ts: item.ts,
        user: item.user,
        userName: item.user,
        text: cleanedText,
        isMessagingBot: false,
      },
      log: (entry) => this.logToFile(conversationId, entry),
      processAttachments: async () => [],
      queueKey: conversationId,
      enqueue: (queueKey, work) => this.getQueue(queueKey).enqueue(work),
      handler: this.handler,
      bot: this,
      createContext: (event) => createGithubAdapters(event, this),
    });
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
        err instanceof Error ? err.message : String(err),
      );
      return;
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
  }
}
