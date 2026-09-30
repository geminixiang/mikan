import { withRetry } from "../shared.js";
import type {
  GithubClientOptions,
  GithubCollaboratorPermission,
  GithubCombinedStatus,
  GithubIssue,
  GithubIssueComment,
  GithubPullRequest,
  GithubPullRequestFile,
  GithubPullRequestReview,
  GithubReactionContent,
  GithubRepositoryDetails,
  GithubReviewComment,
  GithubWorkflowJob,
  GithubWorkflowRun,
} from "./types.js";

export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    method: string,
    path: string,
    detail: string,
  ) {
    super(`GitHub ${method} ${path} failed with ${status}: ${detail}`);
    this.name = "GithubApiError";
  }
}

export function githubIsRateLimited(err: Error): boolean {
  if (!(err instanceof GithubApiError)) return false;
  return err.status === 429 || (err.status === 403 && /rate limit/i.test(err.message));
}

export const githubRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  withRetry(fn, { isRateLimited: githubIsRateLimited });

export const GITHUB_MAX_COMMENT_LENGTH = 60000;

interface GithubRequestOptions {
  body?: unknown;
  responseText?: boolean;
}

export class GithubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GithubClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async send(
    method: string,
    path: string,
    options: GithubRequestOptions,
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mikan",
        Authorization: `Bearer ${this.token}`,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new GithubApiError(response.status, method, path, detail || response.statusText);
    }
    return response;
  }

  private async request(
    method: string,
    path: string,
    options: GithubRequestOptions = {},
  ): Promise<void> {
    await this.send(method, path, options);
  }

  private async requestBody<T>(
    method: string,
    path: string,
    options: GithubRequestOptions = {},
  ): Promise<T> {
    const response = await this.send(method, path, options);
    if (!options.responseText && response.status === 204) {
      throw new Error(`GitHub ${method} ${path} returned no body (${response.status})`);
    }
    return (await (options.responseText ? response.text() : response.json())) as T;
  }

  async getAuthenticatedUser(): Promise<{ login: string; id: number }> {
    return this.requestBody<{ login: string; id: number }>("GET", "/user");
  }

  async getRepository(owner: string, repo: string): Promise<GithubRepositoryDetails> {
    const details = await this.requestBody<GithubRepositoryDetails>(
      "GET",
      `/repos/${owner}/${repo}`,
    );
    return details;
  }

  async getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<GithubCollaboratorPermission> {
    try {
      const data = await this.requestBody<GithubCollaboratorPermission>(
        "GET",
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
      );
      return data;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        return { permission: "none" };
      }
      throw err;
    }
  }

  async createPullRequest(
    owner: string,
    repo: string,
    params: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ): Promise<GithubPullRequest> {
    const pr = await this.requestBody<GithubPullRequest>("POST", `/repos/${owner}/${repo}/pulls`, {
      body: params,
    });
    return pr;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<GithubPullRequest> {
    const pr = await this.requestBody<GithubPullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}`,
    );
    return pr;
  }

  async listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPullRequestFile[]> {
    const files = await this.requestBody<GithubPullRequestFile[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    );
    return files;
  }

  async listPullRequestReviews(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPullRequestReview[]> {
    const reviews = await this.requestBody<GithubPullRequestReview[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
    );
    return reviews;
  }

  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubIssueComment[]> {
    const comments = await this.requestBody<GithubIssueComment[]>(
      "GET",
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=30`,
    );
    return comments;
  }

  async listIssues(
    owner: string,
    repo: string,
    filters: { state?: string; labels?: string; creator?: string } = {},
  ): Promise<GithubIssue[]> {
    const params = new URLSearchParams({
      state: filters.state ?? "open",
      sort: "updated",
      direction: "desc",
      per_page: "30",
    });
    if (filters.labels) params.set("labels", filters.labels);
    if (filters.creator) params.set("creator", filters.creator);
    const issues = await this.requestBody<GithubIssue[]>(
      "GET",
      `/repos/${owner}/${repo}/issues?${params}`,
    );
    return issues;
  }

  async findOpenPullRequestByBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GithubPullRequest | null> {
    const prs = await this.requestBody<GithubPullRequest[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
    );
    return prs[0] ?? null;
  }

  async getCombinedStatus(owner: string, repo: string, ref: string): Promise<GithubCombinedStatus> {
    return this.requestBody<GithubCombinedStatus>(
      "GET",
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status?per_page=100`,
    );
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<GithubWorkflowRun[]> {
    const data = await this.requestBody<{ workflow_runs: GithubWorkflowRun[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=20`,
    );
    return data.workflow_runs;
  }

  async listWorkflowJobs(owner: string, repo: string, runId: number): Promise<GithubWorkflowJob[]> {
    const data = await this.requestBody<{ jobs: GithubWorkflowJob[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    );
    return data.jobs;
  }

  async getJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const text = await this.requestBody<string>(
      "GET",
      `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      { responseText: true },
    );
    return text;
  }

  async listPullReviewComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubReviewComment[]> {
    const comments = await this.requestBody<GithubReviewComment[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
    );
    return comments;
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GithubIssue> {
    const issue = await this.requestBody<GithubIssue>(
      "GET",
      `/repos/${owner}/${repo}/issues/${number}`,
    );
    return issue;
  }

  async addIssueLabels(
    owner: string,
    repo: string,
    number: number,
    labels: string[],
  ): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, {
      body: { labels },
    });
  }

  async removeIssueLabel(
    owner: string,
    repo: string,
    number: number,
    label: string,
  ): Promise<void> {
    await this.request(
      "DELETE",
      `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
    );
  }

  async addIssueAssignees(
    owner: string,
    repo: string,
    number: number,
    assignees: string[],
  ): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${number}/assignees`, {
      body: { assignees },
    });
  }

  async removeIssueAssignees(
    owner: string,
    repo: string,
    number: number,
    assignees: string[],
  ): Promise<void> {
    await this.request("DELETE", `/repos/${owner}/${repo}/issues/${number}/assignees`, {
      body: { assignees },
    });
  }

  async updateIssueState(
    owner: string,
    repo: string,
    number: number,
    state: "open" | "closed",
    stateReason?: string,
  ): Promise<void> {
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/${number}`, {
      body: { state, state_reason: stateReason || undefined },
    });
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GithubIssueComment> {
    return this.requestBody<GithubIssueComment>(
      "POST",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body: { body } },
    );
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      body: { body },
    });
  }

  async deleteIssueComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.request("DELETE", `/repos/${owner}/${repo}/issues/comments/${commentId}`);
  }

  async createCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: GithubReactionContent,
  ): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
      body: { content },
    });
  }

  async replyToReviewComment(
    owner: string,
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<GithubReviewComment> {
    return this.requestBody<GithubReviewComment>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      { body: { body } },
    );
  }

  async createReviewCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: GithubReactionContent,
  ): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`, {
      body: { content },
    });
  }

  async createIssueReaction(
    owner: string,
    repo: string,
    number: number,
    content: GithubReactionContent,
  ): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${number}/reactions`, {
      body: { content },
    });
  }
}
