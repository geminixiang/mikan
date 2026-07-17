import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../../../tools/host-fn-tool.js";

const githubReviewReplySchema = Type.Object({
  comment_id: Type.Number({
    description:
      "Numeric id from an [PR review comment rc-<id> …] message in this conversation " +
      "(e.g. 8001 for rc-8001). The reply lands inside that comment's thread.",
  }),
  body: Type.String({ description: "Reply text (Markdown)." }),
});

export type GithubReviewReplyFn = (commentId: number, body: string) => Promise<{ url: string }>;

/**
 * The `github_review_reply` tool answers inside one inline PR review thread
 * (the responder's normal replies post as plain PR comments instead). Runs
 * host-side as the App; wired per run and only for GitHub conversations.
 */
export function createGithubReviewReplyTool(): {
  tool: AgentTool<typeof githubReviewReplySchema>;
  setGithubReviewReplyFunction: (fn: GithubReviewReplyFn | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubReviewReplyFn, typeof githubReviewReplySchema>({
    name: "github_review_reply",
    description:
      "Reply inside a specific PR review thread. Use the numeric id from an " +
      "[PR review comment rc-<id> …] message as comment_id; a plain response would post " +
      "as a normal PR comment instead of in-thread. Only available in GitHub PR conversations.",
    parameters: githubReviewReplySchema,
    unavailable: "github_review_reply is only available in GitHub conversations.",
    run: async (replyFn, args) => {
      const result = await replyFn(args.comment_id, args.body);
      return {
        content: [
          {
            type: "text" as const,
            text: `Replied in review thread rc-${args.comment_id}: ${result.url}`,
          },
        ],
        details: undefined,
      };
    },
  });

  return { tool, setGithubReviewReplyFunction: setFn };
}
