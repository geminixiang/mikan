import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { defineHostFnTool } from "../../../harness/tools/host-fn-tool.js";

export const GITHUB_REVIEW_REPLY_TOOL = "github_review_reply";

const githubReviewReplySchema = Type.Object({
  comment_id: Type.Number({
    description:
      "Numeric id from an [PR review comment rc-<id> …] message in this conversation " +
      "(e.g. 8001 for rc-8001). The reply lands inside that comment's thread.",
  }),
  body: Type.String({ description: "Reply text (Markdown)." }),
});

import type { GithubReviewReplyFn } from "../types.js";

export function createGithubReviewReplyTool(): {
  tool: AgentTool<typeof githubReviewReplySchema>;
  setGithubReviewReplyFunction: (fn: GithubReviewReplyFn | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubReviewReplyFn, typeof githubReviewReplySchema>({
    name: GITHUB_REVIEW_REPLY_TOOL,
    description:
      "Reply inside a specific PR review thread. Use the numeric id from an " +
      "[PR review comment rc-<id> …] message as comment_id; a plain response would post " +
      "as a normal PR comment instead of in-thread. Only available in GitHub PR conversations.",
    parameters: githubReviewReplySchema,
    unavailable: `${GITHUB_REVIEW_REPLY_TOOL} is only available in GitHub conversations.`,
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
