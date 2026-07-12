import type { ConversationEvent } from "../../adapter.js";

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
  workingDir: string;
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
  /** When the conversation is a PR: fetch and checkout its head as pr-<n>. */
  prNumber?: number;
}

export interface PushBranchOptions {
  dir: string;
  branch: string;
  token: string;
}

export interface GithubClientOptions {
  appId: string;
  privateKey: string;
  installationId: string;
  /** Override the API root for tests; defaults to https://api.github.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}
