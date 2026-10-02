import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { GITHUB_ISSUE_BODY_TS, githubReviewCommentTs } from "./ids.js";
import type { GithubActivity, GithubWebhookDelivery } from "./types.js";

const User = Type.Object({ login: Type.String(), type: Type.String() });

const Repository = Type.Object({
  name: Type.String(),
  private: Type.Boolean(),
  owner: Type.Object({ login: Type.String() }),
});

const IssueLike = Type.Object({
  number: Type.Number(),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  user: User,
  created_at: Type.String(),
});

const Base = { repository: Repository, sender: User };

const IssuesPayload = Type.Object({
  ...Base,
  action: Type.String(),
  issue: IssueLike,
  assignee: Type.Optional(Type.Union([Type.Object({ login: Type.String() }), Type.Null()])),
});

const PullRequestPayload = Type.Object({
  ...Base,
  action: Type.String(),
  pull_request: IssueLike,
  assignee: Type.Optional(Type.Union([Type.Object({ login: Type.String() }), Type.Null()])),
  requested_reviewer: Type.Optional(Type.Object({ login: Type.String() })),
});

const IssueCommentPayload = Type.Object({
  ...Base,
  action: Type.String(),
  issue: IssueLike,
  comment: Type.Object({
    id: Type.Number(),
    body: Type.String(),
    user: User,
    created_at: Type.String(),
  }),
});

const ReviewCommentPayload = Type.Object({
  ...Base,
  action: Type.String(),
  pull_request: IssueLike,
  comment: Type.Object({
    id: Type.Number(),
    body: Type.String(),
    user: User,
    created_at: Type.String(),
    path: Type.String(),
    line: Type.Union([Type.Number(), Type.Null()]),
    diff_hunk: Type.String(),
    in_reply_to_id: Type.Optional(Type.Number()),
  }),
});

function read<T extends TSchema>(schema: T, payload: unknown): Static<T> | null {
  return Value.Check(schema, payload) ? payload : null;
}

type IssueLikeValue = Static<typeof IssueLike>;

function activityBase(
  payload: { repository: Static<typeof Repository>; sender: Static<typeof User> },
  issue: IssueLikeValue,
): Omit<GithubActivity, "kind" | "target" | "ts" | "text" | "createdAt"> {
  return {
    repo: {
      owner: payload.repository.owner.login.toLowerCase(),
      repo: payload.repository.name.toLowerCase(),
      private: payload.repository.private,
    },
    number: issue.number,
    sender: { login: payload.sender.login, isBot: payload.sender.type === "Bot" },
  };
}

function issueText(issue: IssueLikeValue): string {
  return `# ${issue.title}\n\n${issue.body ?? ""}`.trim();
}

function fromIssueOrPr(
  payload: Static<typeof IssuesPayload> | Static<typeof PullRequestPayload>,
  issue: IssueLikeValue,
  now: string,
): GithubActivity | null {
  const base = activityBase(payload, issue);
  const bodyTs = { ts: GITHUB_ISSUE_BODY_TS, text: issueText(issue) };
  switch (payload.action) {
    case "opened":
      return { ...base, ...bodyTs, kind: "opened", target: null, createdAt: issue.created_at };
    case "assigned":
      return payload.assignee
        ? { ...base, ...bodyTs, kind: "assigned", target: payload.assignee.login, createdAt: now }
        : null;
    case "review_requested":
      return "requested_reviewer" in payload && payload.requested_reviewer
        ? {
            ...base,
            ...bodyTs,
            kind: "review_requested",
            target: payload.requested_reviewer.login,
            createdAt: now,
          }
        : null;
    default:
      return null;
  }
}

export function readGithubActivity(
  delivery: GithubWebhookDelivery,
  now = new Date().toISOString(),
): GithubActivity | null {
  switch (delivery.event) {
    case "issues": {
      const payload = read(IssuesPayload, delivery.payload);
      return payload ? fromIssueOrPr(payload, payload.issue, now) : null;
    }
    case "pull_request": {
      const payload = read(PullRequestPayload, delivery.payload);
      return payload ? fromIssueOrPr(payload, payload.pull_request, now) : null;
    }
    case "issue_comment": {
      const payload = read(IssueCommentPayload, delivery.payload);
      if (!payload || payload.action !== "created") return null;
      return {
        ...activityBase(payload, payload.issue),
        kind: "comment",
        sender: { login: payload.comment.user.login, isBot: payload.comment.user.type === "Bot" },
        target: null,
        ts: String(payload.comment.id),
        text: payload.comment.body,
        createdAt: payload.comment.created_at,
      };
    }
    case "pull_request_review_comment": {
      const payload = read(ReviewCommentPayload, delivery.payload);
      if (!payload || payload.action !== "created") return null;
      const { comment } = payload;
      return {
        ...activityBase(payload, payload.pull_request),
        kind: "review_comment",
        sender: { login: comment.user.login, isBot: comment.user.type === "Bot" },
        target: null,
        ts: githubReviewCommentTs(comment.id),
        text: comment.body,
        createdAt: comment.created_at,
        review: {
          commentId: comment.id,
          path: comment.path,
          line: comment.line,
          diffHunk: comment.diff_hunk,
          inReplyToId: comment.in_reply_to_id,
        },
      };
    }
    default:
      return null;
  }
}
