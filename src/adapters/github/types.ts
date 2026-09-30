import type { ConversationEvent } from "../../types.js";
import type { Workspace } from "../../office/types.js";
import type { GithubMessagingBot } from "./bot.js";
import type { GithubClient } from "./client.js";

export interface GithubEvent extends ConversationEvent {
  type: "message" | "issue";
  userName?: string;
}

export type GithubApi = Pick<GithubClient, keyof GithubClient>;

export type GithubConversationBot = Pick<
  GithubMessagingBot,
  | "postComment"
  | "updateMessage"
  | "deleteComment"
  | "addReaction"
  | "logBotResponse"
  | "getMessagingInfo"
  | "capabilities"
  | "agentIdentity"
>;

export type GithubTrigger = "mention" | "assign" | "review" | "followup";

export type GithubCapability = "triage" | "push";

export type GithubTriggerPermission = "write" | "maintain" | "admin";

export interface GithubPolicy {
  repos: string[];
  publicRepos: boolean;
  users: string[] | null;
  minPermission: GithubTriggerPermission;
  triggers: ReadonlySet<GithubTrigger>;
  capabilities: ReadonlySet<GithubCapability>;
}

export interface GithubBotConfig {
  token: string;
  policy: GithubPolicy;
  workspace: Workspace;
}

export interface GithubAgentIdentity {
  login: string;
  email: string;
}

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

export interface GithubActivity {
  kind: "opened" | "comment" | "review_comment" | "assigned" | "review_requested";
  repo: GithubRepoRef & { private: boolean };
  number: number;
  isPr: boolean;
  sender: { login: string; isBot: boolean };
  target: string | null;
  ts: string;
  text: string;
  createdAt: string;
  issueTitle: string;
  issueBody: string;
  review?: GithubReviewAnchor;
}

export interface GithubReviewAnchor {
  commentId: number;
  path: string;
  line: number | null;
  diffHunk: string;
  inReplyToId?: number;
}

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
  issue_url: string;
}

export interface GithubReviewComment {
  id: number;
  body: string;
  user: GithubUser;
  created_at: string;
  updated_at: string;
  pull_request_url: string;
  path: string;
  line: number | null;
  diff_hunk: string;
  in_reply_to_id?: number;
}

export interface GithubRepositoryDetails {
  default_branch: string;
}

export interface GithubCollaboratorPermission {
  permission: string;
  role_name?: string;
}

export interface GithubPullRequest {
  number: number;
  html_url: string;
  head?: { ref: string; sha: string; repo?: { full_name?: string } | null };
  base?: { ref: string };
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  mergeable_state?: string;
  changed_files?: number;
  additions?: number;
  deletions?: number;
  user?: GithubUser;
}

export interface GithubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GithubPullRequestReview {
  id: number;
  user: GithubUser;
  body: string | null;
  state: string;
  submitted_at?: string;
}

export interface GithubCombinedStatus {
  sha: string;
  statuses: {
    id: number;
    context: string;
    state: string;
    description: string | null;
    target_url: string | null;
  }[];
}

export interface GithubWorkflowRun {
  id: number;
  name: string | null;
}

export interface GithubWorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

export type GithubReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

export interface GithubClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface GithubPrRequest {
  branch: string;
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

export interface GithubPrResult {
  number: number;
  url: string;
  updatedExisting?: boolean;
}

export interface GithubCheckSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  source: "actions" | "status";
  outputSummary: string | null;
}

export interface GithubChecksFns {
  getChecks: (branch?: string) => Promise<GithubCheckSummary[]>;
  getJobLog: (jobId: number) => Promise<string>;
}

export interface GithubReadRequest {
  action: "pr" | "pr_files" | "pr_reviews" | "issue" | "comments" | "list";
  number?: number;
  state?: string;
  labels?: string;
  creator?: string;
}

export type GithubReadResult =
  | { kind: "pr"; pr: GithubPullRequest }
  | { kind: "pr_files"; files: GithubPullRequestFile[] }
  | { kind: "pr_reviews"; reviews: GithubPullRequestReview[]; threads: GithubReviewComment[] }
  | { kind: "issue"; issue: GithubIssue }
  | { kind: "comments"; comments: GithubIssueComment[] }
  | { kind: "list"; issues: GithubIssue[] };

export interface GithubIssueRequest {
  action: "add_labels" | "remove_label" | "add_assignees" | "remove_assignees" | "close" | "reopen";
  number?: number;
  labels?: string[];
  label?: string;
  assignees?: string[];
  state_reason?: "completed" | "not_planned";
}

export type GithubReviewReplyFn = (commentId: number, body: string) => Promise<{ url: string }>;

export type GithubReadFn = (request: GithubReadRequest) => Promise<GithubReadResult>;

export type GithubIssueFn = (request: GithubIssueRequest) => Promise<string>;

export interface PlatformGithubOps {
  createPullRequest(conversationId: string, request: GithubPrRequest): Promise<GithubPrResult>;
  getChecks(conversationId: string, branch?: string): Promise<GithubCheckSummary[]>;
  getJobLog(conversationId: string, jobId: number): Promise<string>;
  replyToReviewThread(
    conversationId: string,
    commentId: number,
    body: string,
  ): Promise<{ url: string }>;
  readGithub(conversationId: string, request: GithubReadRequest): Promise<GithubReadResult>;
  manageIssue(conversationId: string, request: GithubIssueRequest): Promise<string>;
}

export interface GithubWebhookDelivery {
  event: string;
  payload: unknown;
}

export interface GithubWebhookOptions {
  secret: string;
  onDelivery: (delivery: GithubWebhookDelivery) => void;
}
