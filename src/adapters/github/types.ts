import type { ConversationEvent } from "../../adapter.js";
import type { Workspace } from "../../office/types.js";

export interface GithubEvent extends ConversationEvent {
  type: "message" | "issue";
  userName?: string;
}

export interface GithubBotConfig {
  appId: string;
  /** PEM-encoded GitHub App private key. */
  privateKey: string;
  installationId: string;
  /** `owner/repo` entries to watch; empty = all installation repositories. */
  repos: string[];
  pollIntervalMs: number;
  workspace: Workspace;
  /**
   * Where the poll watermark state (baseline + seen ids) is persisted. Lives
   * under the host-only state dir: the workspace dir can be mounted into
   * sandboxes, and sandboxed code must not be able to clear dedup state and
   * re-trigger runs.
   */
  syncStatePath: string;
}

/** Persisted per-repo poll watermark (DESIGN.md § Event source). */
interface GithubRepoSyncState {
  /** Comments/issues created before this ISO instant never trigger. */
  baseline: string;
  /** Newest updated_at seen; polls fetch from (cursor - overlap). */
  cursor: string;
  seenComments: number[];
  seenIssues: number[];
  /** Optional so state files written before review-comment polling still load. */
  seenReviewComments?: number[];
}

export interface GithubSyncState {
  repos: Record<string, GithubRepoSyncState>;
}

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export interface GithubConversationRef extends GithubRepoRef {
  number: number;
}

// ── GitHub REST payload shapes (only the fields mikan reads) ─────────────────

interface GithubUser {
  login: string;
  type: string;
}

export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  user: GithubUser;
  created_at: string;
  updated_at: string;
  pull_request?: object;
  /** open | closed */
  state?: string;
  labels?: { name: string }[];
  assignees?: { login: string }[];
}

export interface GithubIssueComment {
  id: number;
  body: string;
  user: GithubUser;
  created_at: string;
  updated_at: string;
  /** API URL of the parent issue, e.g. …/repos/o/r/issues/42 */
  issue_url: string;
}

/** An inline PR review comment (a comment on a diff line). */
export interface GithubReviewComment {
  id: number;
  body: string;
  user: GithubUser;
  created_at: string;
  updated_at: string;
  /** API URL of the parent PR, e.g. …/repos/o/r/pulls/42 */
  pull_request_url: string;
  /** File the comment is anchored to. */
  path: string;
  /** Line in the diff's right side; null when the anchor is outdated. */
  line: number | null;
  /** The diff excerpt the comment is anchored to. */
  diff_hunk: string;
  /** Set on replies: the id of the thread's root comment. */
  in_reply_to_id?: number;
}

export interface GithubRepository {
  name: string;
  owner: GithubUser;
}

export interface GithubRepositoryDetails {
  default_branch: string;
}

export interface GithubCollaboratorPermission {
  /** Legacy field: admin | write | read | none (maintain→write, triage→read). */
  permission: string;
  /** Granular assigned role (admin/maintain/write/triage/read or a custom role). */
  role_name?: string;
}

export interface GithubPullRequest {
  number: number;
  html_url: string;
  /** head.repo is null when the fork a PR came from was deleted. */
  head?: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base?: { ref: string };
  title?: string;
  body?: string | null;
  /** open | closed */
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergeable_state?: string;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  user?: GithubUser;
}

/** One row of GET /pulls/{n}/files. */
export interface GithubPullRequestFile {
  filename: string;
  /** added | removed | modified | renamed | … */
  status: string;
  additions: number;
  deletions: number;
}

/** One submitted review of GET /pulls/{n}/reviews. */
export interface GithubPullRequestReview {
  id: number;
  user: GithubUser;
  body: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  submitted_at?: string;
}

export interface GithubCheckRun {
  /** Check-run id; for GitHub Actions this doubles as the job id (log fetch). */
  id: number;
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | skipped | timed_out | action_required | null while running */
  conclusion: string | null;
  html_url: string | null;
  /** The app that reported the check (github-actions vs external CI). */
  app?: { slug?: string } | null;
  /** Whatever the reporting app posted about the run. */
  output?: { title?: string | null; summary?: string | null } | null;
}

/** Permission subset requestable on a scoped installation token. */
export type GithubTokenPermissions = Partial<
  Record<"contents" | "pull_requests" | "issues", "read" | "write">
>;

export type GithubReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface CloneRepoOptions {
  /** HTTPS remote, e.g. https://github.com/owner/repo.git (no credentials). */
  url: string;
  /** Destination directory (the conversation dir's `repo/`). */
  dir: string;
  /** Ephemeral scoped installation token; used per-invocation, never stored. */
  token: string;
  botLogin: string;
  botEmail: string;
  /** When the conversation is a PR: fetch and check out its head. */
  prNumber?: number;
  /**
   * The PR's head branch name when it lives in this repo (not a fork): the
   * checkout is named after it so committing there + github_pr updates the
   * PR in place. Absent (fork/unknown), the checkout falls back to pr-<n>.
   */
  prHeadBranch?: string;
}

export interface PushBranchOptions {
  dir: string;
  branch: string;
  token: string;
}

export interface SyncRepoOptions {
  dir: string;
  /** Ephemeral contents:read token; used per-invocation, never stored. */
  token: string;
  /** Explicit branch to fetch; wins over prNumber/defaultBranch. */
  branch?: string;
  /** PR conversations: fetch pull/<n>/head into the local PR checkout. */
  prNumber?: number;
  /** Same-repo PR head name; the local checkout target. Fallback: pr-<n>. */
  prHeadBranch?: string;
  /** Fallback target when neither branch nor prNumber applies. */
  defaultBranch?: string;
}

export interface SyncRepoResult {
  /** Local branch the fetch targets (the PR head name, pr-<n>, or the branch). */
  target: string;
  fetchedSha: string;
  /** True when the checkout was moved to the fetched head. */
  updatedCheckout: boolean;
  /** Working tree had uncommitted changes (checkout left alone). */
  dirty: boolean;
  currentBranch: string;
  /** Bot-committed (agent-made) commits on the target that origin lacks. */
  localCommits: number;
}

export interface GithubClientOptions {
  appId: string;
  privateKey: string;
  installationId: string;
  /** Override the API root for tests; defaults to https://api.github.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// ── Host-side tool contracts (capability pack, not messaging core) ───────────

/** Arguments for the host-side `github_pr` tool. */
export interface GithubPrRequest {
  /** Local branch in the conversation's ./repo clone; must match pi/<name>. */
  branch: string;
  title: string;
  body?: string;
  /** Target branch; defaults to the repository's default branch. */
  base?: string;
  draft?: boolean;
}

export interface GithubPrResult {
  number: number;
  url: string;
  /** True when the branch already had an open PR that this push updated. */
  updatedExisting?: boolean;
}

/** Normalized check-run row for the host-side `github_checks` tool. */
export interface GithubCheckSummary {
  /** Check-run id; for GitHub Actions checks it is also the job id for log fetch. */
  id: number;
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | … ; null while the run is still in progress */
  conclusion: string | null;
  url: string | null;
  /** Slug of the reporting app; "github-actions" checks have fetchable logs. */
  appSlug: string | null;
  /** The reporting app's own summary of the run, when it posted one. */
  outputSummary: string | null;
}

export interface GithubChecksFns {
  getChecks: (branch?: string) => Promise<GithubCheckSummary[]>;
  getJobLog: (jobId: number) => Promise<string>;
}

/** Arguments for the host-side `github_read` tool. */
export interface GithubReadRequest {
  action: "pr" | "pr_files" | "pr_reviews" | "issue" | "comments" | "list";
  /** Issue/PR number; defaults to the conversation's own. */
  number?: number;
  /** list only: open | closed | all (default open). */
  state?: string;
  /** list only: comma-separated label names. */
  labels?: string;
  /** list only: filter by author login. */
  creator?: string;
}

/** Typed payload of one `github_read` action; the tool renders it. */
export type GithubReadResult =
  | { kind: "pr"; pr: GithubPullRequest }
  | { kind: "pr_files"; files: GithubPullRequestFile[] }
  | { kind: "pr_reviews"; reviews: GithubPullRequestReview[]; threads: GithubReviewComment[] }
  | { kind: "issue"; issue: GithubIssue }
  | { kind: "comments"; comments: GithubIssueComment[] }
  | { kind: "list"; issues: GithubIssue[] };

/** Arguments for the host-side `github_issue` tool. Deliberately a closed
 *  action set: lock/delete/transfer are not offered at all. */
export interface GithubIssueRequest {
  action: "add_labels" | "remove_label" | "add_assignees" | "remove_assignees" | "close" | "reopen";
  /** Issue/PR number; defaults to the conversation's own (triage may target others). */
  number?: number;
  /** add_labels */
  labels?: string[];
  /** remove_label */
  label?: string;
  /** add_assignees / remove_assignees */
  assignees?: string[];
  /** close */
  state_reason?: "completed" | "not_planned";
}

/**
 * Host-side GitHub operations for github_* tools. Wired in main.ts over the
 * GitHub bot; tokens stay host-side. Consumed by `createGithubToolPack`.
 */
export type GithubSyncFn = (branch?: string) => Promise<string>;

export type GithubReviewReplyFn = (commentId: number, body: string) => Promise<{ url: string }>;

export type GithubReadFn = (request: GithubReadRequest) => Promise<GithubReadResult>;

export type GithubIssueFn = (request: GithubIssueRequest) => Promise<string>;

export interface PlatformGithubOps {
  /** Push a prepared pi/* branch and open (or update) a pull request. */
  pushAndCreatePr(conversationId: string, request: GithubPrRequest): Promise<GithubPrResult>;
  /** CI check runs for a branch, or for the conversation's PR head when omitted. */
  getChecks(conversationId: string, branch?: string): Promise<GithubCheckSummary[]>;
  /** Log text of one CI job (an Actions check-run id), tail-truncated. */
  getJobLog(conversationId: string, jobId: number): Promise<string>;
  /** Reply inside one inline review thread of the conversation's PR. */
  replyToReviewThread(
    conversationId: string,
    commentId: number,
    body: string,
  ): Promise<{ url: string }>;
  /** Refresh the conversation's ./repo clone; returns a human-readable report. */
  syncRepo(conversationId: string, branch?: string): Promise<string>;
  /** Read PR/issue metadata the clone cannot provide; same repo only. */
  readGithub(conversationId: string, request: GithubReadRequest): Promise<GithubReadResult>;
  /** Label/assignee/state management on this repo's issues; returns a report. */
  manageIssue(conversationId: string, request: GithubIssueRequest): Promise<string>;
}

export interface GithubWebhookOptions {
  secret: string;
  /** Called after signature verification for relevant events. */
  onPoke: () => void;
}
