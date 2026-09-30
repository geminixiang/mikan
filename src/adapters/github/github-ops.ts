import * as log from "../../log.js";
import { GithubApiError, GITHUB_MAX_COMMENT_LENGTH, githubRetry } from "./client.js";
import { parseGithubConversationId } from "../../office/index.js";
import type {
  GithubApi,
  GithubCheckSummary,
  GithubIssueRequest,
  GithubPrRequest,
  GithubPrResult,
  GithubReadRequest,
  GithubReadResult,
  PlatformGithubOps,
} from "./types.js";

const MAX_LOG_CHARS = 20000;

export class GithubOps implements PlatformGithubOps {
  constructor(private readonly client: GithubApi) {}

  async createPullRequest(
    conversationId: string,
    request: GithubPrRequest,
  ): Promise<GithubPrResult> {
    const ref = parseGithubConversationId(conversationId);
    const repository = await githubRetry(() => this.client.getRepository(ref.owner, ref.repo));
    const base = request.base ?? repository.default_branch;
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
            `[${conversationId}] Branch already has PR #${existing.number}: ${existing.html_url}`,
          );
          return { number: existing.number, url: existing.html_url, updatedExisting: true };
        }
      }
      throw err;
    }
  }

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
    const status = await githubRetry(() =>
      this.client.getCombinedStatus(ref.owner, ref.repo, target),
    );
    const runs = await githubRetry(() =>
      this.client.listWorkflowRuns(ref.owner, ref.repo, status.sha),
    );
    const jobs = await Promise.all(
      runs.map(async (run) => {
        const runJobs = await githubRetry(() =>
          this.client.listWorkflowJobs(ref.owner, ref.repo, run.id),
        );
        return runJobs.map(
          (job): GithubCheckSummary => ({
            id: job.id,
            name: run.name ? `${run.name} / ${job.name}` : job.name,
            status: job.status,
            conclusion: job.conclusion,
            url: job.html_url,
            source: "actions",
            outputSummary: null,
          }),
        );
      }),
    );
    const statuses = status.statuses.map(
      (entry): GithubCheckSummary => ({
        id: entry.id,
        name: entry.context,
        status: entry.state === "pending" ? "in_progress" : "completed",
        conclusion:
          entry.state === "pending" ? null : entry.state === "success" ? "success" : "failure",
        url: entry.target_url,
        source: "status",
        outputSummary: entry.description?.trim() ? entry.description.slice(0, 500) : null,
      }),
    );
    return [...jobs.flat(), ...statuses];
  }

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

  async manageIssue(conversationId: string, request: GithubIssueRequest): Promise<string> {
    const ref = parseGithubConversationId(conversationId);
    const number = request.number ?? ref.number;
    try {
      switch (request.action) {
        case "add_labels": {
          const labels = request.labels;
          if (!labels?.length) {
            throw new Error("add_labels requires a non-empty labels array.");
          }
          await githubRetry(() => this.client.addIssueLabels(ref.owner, ref.repo, number, labels));
          return `Added label(s) ${labels.join(", ")} to #${number}.`;
        }
        case "remove_label": {
          const label = request.label;
          if (!label) {
            throw new Error("remove_label requires a label name.");
          }
          await githubRetry(() => this.client.removeIssueLabel(ref.owner, ref.repo, number, label));
          return `Removed label ${label} from #${number}.`;
        }
        case "add_assignees": {
          const assignees = request.assignees;
          if (!assignees?.length) {
            throw new Error("add_assignees requires a non-empty assignees array.");
          }
          await githubRetry(() =>
            this.client.addIssueAssignees(ref.owner, ref.repo, number, assignees),
          );
          return `Assigned ${assignees.map((login) => `@${login}`).join(", ")} to #${number}.`;
        }
        case "remove_assignees": {
          const assignees = request.assignees;
          if (!assignees?.length) {
            throw new Error("remove_assignees requires a non-empty assignees array.");
          }
          await githubRetry(() =>
            this.client.removeIssueAssignees(ref.owner, ref.repo, number, assignees),
          );
          return `Unassigned ${assignees.map((login) => `@${login}`).join(", ")} from #${number}.`;
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
            `in your clone instead. Do not retry with other ids.`,
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
