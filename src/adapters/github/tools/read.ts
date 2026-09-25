import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../../../harness/tools/host-fn-tool.js";
import type {
  GithubPullRequest,
  GithubReadFn,
  GithubReadRequest,
  GithubReadResult,
} from "../types.js";

export type { GithubReadFn } from "../types.js";

export const GITHUB_READ_TOOL = "github_read";

const githubReadSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("pr"),
      Type.Literal("pr_files"),
      Type.Literal("pr_reviews"),
      Type.Literal("issue"),
      Type.Literal("comments"),
      Type.Literal("list"),
    ],
    {
      description:
        "pr: PR metadata (state, base/head, diff stats). pr_files: changed files. " +
        "pr_reviews: submitted reviews + open inline threads (with rc- ids for " +
        "github_review_reply). issue: issue metadata. comments: recent conversation " +
        "comments. list: issues/PRs in this repo.",
    },
  ),
  number: Type.Optional(
    Type.Number({
      description: "Issue/PR number to read; omit for this conversation's own.",
    }),
  ),
  state: Type.Optional(
    Type.String({ description: "list only: open | closed | all (default open)." }),
  ),
  labels: Type.Optional(
    Type.String({ description: "list only: comma-separated label names to filter by." }),
  ),
  creator: Type.Optional(Type.String({ description: "list only: filter by author login." })),
});

const MAX_BODY_CHARS = 1000;
const MAX_COMMENT_CHARS = 500;
const MAX_REVIEW_BODY_CHARS = 300;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatPr(pr: GithubPullRequest): string {
  const flags = [
    pr.state ?? "unknown",
    pr.draft ? "draft" : null,
    pr.merged ? "merged" : null,
    pr.mergeable_state ? `mergeable_state: ${pr.mergeable_state}` : null,
  ].filter(Boolean);
  return [
    `PR #${pr.number}: ${pr.title ?? ""} [${flags.join(", ")}]`,
    `${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"} | ${pr.changed_files ?? "?"} files, +${pr.additions ?? "?"} -${pr.deletions ?? "?"}`,
    pr.user ? `author: @${pr.user.login}` : null,
    pr.body ? truncate(pr.body, MAX_BODY_CHARS) : "(no description)",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatReviews({
  reviews,
  threads,
}: Extract<GithubReadResult, { kind: "pr_reviews" }>): string {
  const reviewLines = reviews
    .filter((review) => review.state !== "PENDING")
    .map((review) => {
      const body = review.body?.trim() ? ` — ${truncate(review.body, MAX_REVIEW_BODY_CHARS)}` : "";
      return `@${review.user.login}: ${review.state}${body}`;
    });
  const replyCounts = new Map<number | undefined, number>();
  for (const { in_reply_to_id: parent } of threads) {
    replyCounts.set(parent, (replyCounts.get(parent) ?? 0) + 1);
  }
  const threadLines = threads
    .filter((comment) => comment.in_reply_to_id === undefined)
    .map((comment) => {
      const location = comment.line !== null ? `${comment.path}:${comment.line}` : comment.path;
      const count = replyCounts.get(comment.id) ?? 0;
      const replyNote = count ? ` (${count} repl${count === 1 ? "y" : "ies"})` : "";
      return `rc-${comment.id} ${location} @${comment.user.login}${replyNote}: ${truncate(comment.body, MAX_REVIEW_BODY_CHARS)}`;
    });
  return [
    reviewLines.length ? `Reviews:\n${reviewLines.join("\n")}` : "No submitted reviews.",
    threadLines.length
      ? `Inline threads (reply with github_review_reply):\n${threadLines.join("\n")}`
      : "No inline review threads.",
  ].join("\n\n");
}

function formatResult(result: GithubReadResult): string {
  switch (result.kind) {
    case "pr":
      return formatPr(result.pr);
    case "pr_files": {
      if (result.files.length === 0) return "No changed files.";
      const lines = result.files.map(
        (file) => `${file.status.padEnd(8)} ${file.filename} +${file.additions} -${file.deletions}`,
      );
      return [`${result.files.length} changed file(s):`, ...lines].join("\n");
    }
    case "pr_reviews":
      return formatReviews(result);
    case "issue": {
      const issue = result.issue;
      const labels = (issue.labels ?? []).map((label) => label.name).join(", ");
      const assignees = (issue.assignees ?? []).map((assignee) => `@${assignee.login}`).join(", ");
      return [
        `#${issue.number}: ${issue.title} [${issue.state ?? "unknown"}${issue.pull_request ? ", PR" : ""}]`,
        labels ? `labels: ${labels}` : null,
        assignees ? `assignees: ${assignees}` : null,
        `author: @${issue.user.login}`,
        issue.body ? truncate(issue.body, MAX_BODY_CHARS) : "(no body)",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "comments": {
      return (
        result.comments
          .map(
            (comment) =>
              `@${comment.user.login} (${comment.created_at}): ${truncate(comment.body, MAX_COMMENT_CHARS)}`,
          )
          .join("\n") || "No comments."
      );
    }
    case "list": {
      return (
        result.issues
          .map((issue) => {
            const labels = (issue.labels ?? []).map((label) => label.name).join(", ");
            const kind = issue.pull_request ? "PR" : "issue";
            return `#${issue.number} [${issue.state ?? "?"} ${kind}] ${issue.title}${labels ? ` (${labels})` : ""}`;
          })
          .join("\n") || "No matching issues."
      );
    }
  }
}

export function createGithubReadTool(): {
  tool: AgentTool<typeof githubReadSchema>;
  setGithubReadFunction: (fn: GithubReadFn | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubReadFn, typeof githubReadSchema>({
    name: GITHUB_READ_TOOL,
    description:
      "Read GitHub metadata for this repo: PR state/diff stats (pr), changed files " +
      "(pr_files), reviews and open inline threads (pr_reviews), issue metadata (issue), " +
      "recent comments (comments), or a filtered issue/PR listing (list). number defaults " +
      "to this conversation's issue/PR. Only available in GitHub conversations.",
    parameters: githubReadSchema,
    unavailable: `${GITHUB_READ_TOOL} is only available in GitHub conversations.`,
    run: async (readFn, args) => {
      const result = await readFn(args as GithubReadRequest);
      return {
        content: [{ type: "text" as const, text: formatResult(result) }],
        details: undefined,
      };
    },
  });

  return { tool, setGithubReadFunction: setFn };
}
