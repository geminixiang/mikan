import { createSign } from "node:crypto";
import { withRetry } from "../shared.js";
import type {
  GithubCheckRun,
  GithubClientOptions,
  GithubCollaboratorPermission,
  GithubIssue,
  GithubIssueComment,
  GithubPullRequest,
  GithubPullRequestFile,
  GithubPullRequestReview,
  GithubReactionContent,
  GithubRepository,
  GithubRepositoryDetails,
  GithubReviewComment,
  GithubTokenPermissions,
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

function base64Url(data: string | Buffer): string {
  return (typeof data === "string" ? Buffer.from(data) : data).toString("base64url");
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class GithubClient {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly installationId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private installationToken: { value: string; expiresAt: number } | null = null;
  private etags = new Map<string, string>();

  constructor(options: GithubClientOptions) {
    this.appId = options.appId;
    this.privateKey = options.privateKey;
    this.installationId = options.installationId;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }));
    const signature = base64Url(
      createSign("RSA-SHA256").update(`${header}.${payload}`).sign(this.privateKey),
    );
    return `${header}.${payload}.${signature}`;
  }

  private async getInstallationToken(): Promise<string> {
    const cached = this.installationToken;
    if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.value;
    }
    const data = await this.rawRequest<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${this.installationId}/access_tokens`,
      { auth: `Bearer ${this.appJwt()}` },
    );
    this.installationToken = { value: data!.token, expiresAt: Date.parse(data!.expires_at) };
    return this.installationToken.value;
  }

  private async rawRequest<T>(
    method: string,
    path: string,
    options: { auth: string; body?: unknown; conditional?: boolean; responseText?: boolean },
  ): Promise<T | null> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mikan",
      Authorization: options.auth,
    };
    if (options.conditional) {
      const etag = this.etags.get(path);
      if (etag) headers["If-None-Match"] = etag;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (response.status === 304 && !options.responseText) {
      return null;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new GithubApiError(response.status, method, path, detail || response.statusText);
    }
    if (options.conditional) {
      const etag = response.headers.get("etag");
      if (etag) this.etags.set(path, etag);
    }
    if (response.status === 204 && !options.responseText) {
      return null;
    }
    return (await (options.responseText ? response.text() : response.json())) as T;
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; conditional?: boolean; responseText?: boolean } = {},
  ): Promise<T | null> {
    const token = await this.getInstallationToken();
    return this.rawRequest<T>(method, path, { ...options, auth: `Bearer ${token}` });
  }

  async getAppSlug(): Promise<string> {
    const app = await this.rawRequest<{ slug: string }>("GET", "/app", {
      auth: `Bearer ${this.appJwt()}`,
    });
    return app!.slug;
  }

  async getUserId(login: string): Promise<number> {
    const user = await this.request<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`);
    return user!.id;
  }

  async createScopedInstallationToken(
    repoName: string,
    permissions: GithubTokenPermissions,
  ): Promise<string> {
    const data = await this.rawRequest<{ token: string }>(
      "POST",
      `/app/installations/${this.installationId}/access_tokens`,
      {
        auth: `Bearer ${this.appJwt()}`,
        body: { repositories: [repoName], permissions },
      },
    );
    return data!.token;
  }

  async getRepository(owner: string, repo: string): Promise<GithubRepositoryDetails> {
    const details = await this.request<GithubRepositoryDetails>("GET", `/repos/${owner}/${repo}`);
    return details!;
  }

  async getCollaboratorPermission(
    owner: string,
    repo: string,
    username: string,
  ): Promise<GithubCollaboratorPermission> {
    try {
      const data = await this.request<GithubCollaboratorPermission>(
        "GET",
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
      );
      return data!;
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
    const pr = await this.request<GithubPullRequest>("POST", `/repos/${owner}/${repo}/pulls`, {
      body: params,
    });
    return pr!;
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<GithubPullRequest> {
    const pr = await this.request<GithubPullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}`,
    );
    return pr!;
  }

  async listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPullRequestFile[]> {
    const files = await this.request<GithubPullRequestFile[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    );
    return files!;
  }

  async listPullRequestReviews(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPullRequestReview[]> {
    const reviews = await this.request<GithubPullRequestReview[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`,
    );
    return reviews!;
  }

  async submitUserReview(
    owner: string,
    repo: string,
    number: number,
    body: string,
    token: string,
  ): Promise<{ html_url: string }> {
    const review = await this.rawRequest<{ html_url: string }>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      { auth: `Bearer ${token}`, body: { body, event: "COMMENT" } },
    );
    return review!;
  }

  async listIssueComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubIssueComment[]> {
    const comments = await this.request<GithubIssueComment[]>(
      "GET",
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=30`,
    );
    return comments!;
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
    const issues = await this.request<GithubIssue[]>(
      "GET",
      `/repos/${owner}/${repo}/issues?${params}`,
    );
    return issues!;
  }

  async findOpenPullRequestByBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<GithubPullRequest | null> {
    const prs = await this.request<GithubPullRequest[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
    );
    return prs?.[0] ?? null;
  }

  async listCheckRuns(owner: string, repo: string, ref: string): Promise<GithubCheckRun[]> {
    const data = await this.request<{ check_runs: GithubCheckRun[] }>(
      "GET",
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`,
    );
    return data!.check_runs;
  }

  async getJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const text = await this.request<string>(
      "GET",
      `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      { responseText: true },
    );
    return text!;
  }

  async listInstallationRepositories(): Promise<GithubRepository[]> {
    const data = await this.request<{ repositories: GithubRepository[] }>(
      "GET",
      "/installation/repositories?per_page=100",
    );
    return data!.repositories;
  }

  async listIssueCommentsSince(
    owner: string,
    repo: string,
    since: string,
  ): Promise<GithubIssueComment[] | null> {
    return this.request<GithubIssueComment[]>(
      "GET",
      `/repos/${owner}/${repo}/issues/comments?sort=updated&direction=asc&since=${encodeURIComponent(since)}&per_page=100`,
      { conditional: true },
    );
  }

  async listPullReviewCommentsSince(
    owner: string,
    repo: string,
    since: string,
  ): Promise<GithubReviewComment[] | null> {
    return this.request<GithubReviewComment[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/comments?sort=updated&direction=asc&since=${encodeURIComponent(since)}&per_page=100`,
      { conditional: true },
    );
  }

  async listPullReviewComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubReviewComment[]> {
    const comments = await this.request<GithubReviewComment[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`,
    );
    return comments!;
  }

  async listIssuesSince(owner: string, repo: string, since: string): Promise<GithubIssue[] | null> {
    return this.request<GithubIssue[]>(
      "GET",
      `/repos/${owner}/${repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}&per_page=100`,
      { conditional: true },
    );
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GithubIssue> {
    const issue = await this.request<GithubIssue>(
      "GET",
      `/repos/${owner}/${repo}/issues/${number}`,
    );
    return issue!;
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
      body: { state, ...(stateReason ? { state_reason: stateReason } : {}) },
    });
  }

  async createIssueComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GithubIssueComment> {
    const comment = await this.request<GithubIssueComment>(
      "POST",
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body: { body } },
    );
    return comment!;
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
    const comment = await this.request<GithubReviewComment>(
      "POST",
      `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`,
      { body: { body } },
    );
    return comment!;
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
