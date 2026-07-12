import { createSign } from "crypto";
import type {
  GithubClientOptions,
  GithubCollaboratorPermission,
  GithubIssue,
  GithubIssueComment,
  GithubPullRequest,
  GithubReactionContent,
  GithubRepository,
  GithubRepositoryDetails,
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

/**
 * GitHub rate-limit responses are 429, or 403 with a rate-limit message
 * (secondary limits). Used as the `withRetry` predicate.
 */
export function githubIsRateLimited(err: Error): boolean {
  if (!(err instanceof GithubApiError)) return false;
  return err.status === 429 || (err.status === 403 && /rate limit/i.test(err.message));
}

function base64Url(data: string | Buffer): string {
  return (typeof data === "string" ? Buffer.from(data) : data).toString("base64url");
}

/** Refresh the cached installation token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Minimal GitHub REST client authenticated as a GitHub App installation.
 * Mints short-lived installation tokens from an RS256 app JWT and supports
 * ETag conditional polling (304 responses don't count against the rate limit).
 */
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

  /** Short-lived JWT identifying the App itself (not an installation). */
  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    // 60s clock-drift backdate; GitHub caps exp at 10 minutes.
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
    options: { auth: string; body?: unknown; conditional?: boolean },
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
    if (response.status === 304) {
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
    if (response.status === 204) {
      return null;
    }
    return (await response.json()) as T;
  }

  /**
   * Installation-authenticated request. `conditional` GETs return null on 304
   * (nothing changed since the last call to the same path).
   */
  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; conditional?: boolean } = {},
  ): Promise<T | null> {
    const token = await this.getInstallationToken();
    return this.rawRequest<T>(method, path, { ...options, auth: `Bearer ${token}` });
  }

  /** The App's mention slug; its comments author as `<slug>[bot]`. */
  async getAppSlug(): Promise<string> {
    const app = await this.rawRequest<{ slug: string }>("GET", "/app", {
      auth: `Bearer ${this.appJwt()}`,
    });
    return app!.slug;
  }

  /** Database id of a user/bot login (for noreply commit-author emails). */
  async getUserId(login: string): Promise<number> {
    const user = await this.request<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`);
    return user!.id;
  }

  /**
   * Mint a one-off installation token narrowed to a single repo and an
   * explicit permission subset. Used for host-side git operations so the
   * broad installation identity never leaves this process.
   */
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

  /**
   * A user's effective role on a repo: granular `role_name` plus the legacy
   * `permission` field (callers rank whichever is stronger, so custom roles
   * still resolve via their legacy mapping). Needs only Metadata: Read — the
   * mandatory App permission. Unknown users resolve to none.
   */
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

  async listInstallationRepositories(): Promise<GithubRepository[]> {
    const data = await this.request<{ repositories: GithubRepository[] }>(
      "GET",
      "/installation/repositories?per_page=100",
    );
    return data!.repositories;
  }

  /**
   * All issue/PR conversation comments in a repo updated at or after `since`,
   * oldest first. Returns null when nothing changed (ETag 304). Capped at one
   * page; the poll cursor advances to the newest item seen, so a burst larger
   * than 100 comments drains across consecutive polls.
   */
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

  /** Issues and PRs updated at or after `since` (GitHub lists PRs as issues). */
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
