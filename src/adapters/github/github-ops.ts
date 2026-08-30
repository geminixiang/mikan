import { existsSync } from "node:fs";
import * as log from "../../log.js";
import type { GithubClient } from "./client.js";
import { GithubApiError, GITHUB_MAX_COMMENT_LENGTH, githubRetry } from "./client.js";
import { parseGithubConversationId } from "./ids.js";
import { conversationRepoDir, GITHUB_PUSH_BRANCH_PATTERN, pushBranch, syncRepo } from "./repo.js";
import { createOfficeAddress } from "../../office/index.js";
import type { Workspace } from "../../office/index.js";
import type {
  GithubCheckSummary,
  GithubConversationRef,
  GithubIssueRequest,
  GithubPrRequest,
  GithubPrResult,
  GithubReadRequest,
  GithubReadResult,
  PlatformGithubOps,
} from "./types.js";

/** CI job logs are tail-truncated to this many characters. */
const MAX_LOG_CHARS = 20000;

/** Whether the conversation's issue is a PR, for callers where the triggering
 *  item didn't carry that knowledge. Errs toward plain issue. */
export async function fetchIsPr(
  client: GithubClient,
  ref: GithubConversationRef,
): Promise<boolean> {
  try {
    const issue = await githubRetry(() => client.getIssue(ref.owner, ref.repo, ref.number));
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
export async function fetchPrHeadBranch(
  client: GithubClient,
  ref: GithubConversationRef,
): Promise<string | undefined> {
  try {
    const pr = await githubRetry(() => client.getPullRequest(ref.owner, ref.repo, ref.number));
    const sameRepo =
      pr.head?.repo?.full_name?.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase();
    return sameRepo ? pr.head?.ref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Host-side backend of the github_* tool pack (`PlatformGithubOps`),
 * standalone from the messaging bot: it needs the API client, the
 * conversation working dir — not the poll
 * loop, queues, or trigger gate. Tokens are minted per call, scoped to the
 * conversation's repo, and never enter the sandbox.
 */
export class GithubOps implements PlatformGithubOps {
  constructor(
    private readonly client: GithubClient,
    private readonly config: { workspace: Workspace },
  ) {}

  private repoDir(conversationId: string): string {
    return conversationRepoDir(
      this.config.workspace.office(createOfficeAddress("github", conversationId)),
    );
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
    return runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      appSlug: run.app?.slug ?? null,
      outputSummary: run.output?.summary?.trim() ? run.output.summary.slice(0, 500) : null,
    }));
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
      if (await fetchIsPr(this.client, ref)) {
        prNumber = ref.number;
        prHeadBranch = await fetchPrHeadBranch(this.client, ref);
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
   * GitHub Actions checks have logs on GitHub; external CI apps keep theirs
   * on their own service, so a 404 here becomes guidance instead of a dead end.
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
            `by github-actions; external CI keeps logs on its own service — ` +
            `use that check's summary/url from github_checks, or reproduce the failure locally ` +
            `in ./repo instead. Do not retry with other ids.`,
          { cause: err },
        );
      }
      throw err;
    }
    return logText.length > MAX_LOG_CHARS
      ? `…(truncated to the last ${MAX_LOG_CHARS} chars)\n${logText.slice(-MAX_LOG_CHARS)}`
      : logText;
  }
}
