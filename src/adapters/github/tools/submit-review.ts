import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../../../harness/tools/host-fn-tool.js";
import type { GithubSubmitReviewFn } from "../types.js";

const schema = Type.Object({
  body: Type.String({ description: "Markdown review summary for this pull request." }),
});

export function createGithubSubmitReviewTool(): {
  tool: AgentTool<typeof schema>;
  setGithubSubmitReviewFunction: (fn: GithubSubmitReviewFn | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubSubmitReviewFn, typeof schema>({
    name: "github_submit_review",
    description:
      "Submit a formal COMMENT review on this GitHub PR as the configured agent account. " +
      "Use when requested as a PR reviewer; never approve or request changes automatically.",
    parameters: schema,
    unavailable: "github_submit_review is only available in GitHub conversations.",
    run: async (submit, args) => {
      const review = await submit(args.body);
      return {
        content: [{ type: "text" as const, text: `Submitted PR review: ${review.url}` }],
        details: undefined,
      };
    },
  });
  return { tool, setGithubSubmitReviewFunction: setFn };
}
