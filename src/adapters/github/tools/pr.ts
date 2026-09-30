import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { defineHostFnTool } from "../../../harness/tools/host-fn-tool.js";
import type { GithubPrRequest, GithubPrResult } from "../types.js";

export const GITHUB_PR_TOOL = "github_pr";

const githubPrSchema = Type.Object({
  branch: Type.String({
    description:
      'Branch you already pushed from your sandbox (e.g. "pi/fix-42"); it becomes the pull ' +
      "request head.",
  }),
  title: Type.String({ description: "Pull request title." }),
  body: Type.Optional(Type.String({ description: "Pull request description (Markdown)." })),
  base: Type.Optional(
    Type.String({ description: "Target branch; defaults to the repository's default branch." }),
  ),
  draft: Type.Optional(Type.Boolean({ description: "Open as a draft pull request." })),
});

type GithubPrArgs = GithubPrRequest;

export function createGithubPrTool(): {
  tool: AgentTool<typeof githubPrSchema>;
  setGithubPrFunction: (fn: ((request: GithubPrRequest) => Promise<GithubPrResult>) | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<
    (request: GithubPrRequest) => Promise<GithubPrResult>,
    typeof githubPrSchema
  >({
    name: GITHUB_PR_TOOL,
    description:
      "Open a GitHub pull request (or draft) for a branch you already pushed with git from " +
      "your sandbox. If the branch already has an open PR, returns that PR instead of " +
      "opening another. Only available in GitHub issue/PR conversations. You cannot merge — " +
      "humans review and merge the PR.",
    parameters: githubPrSchema,
    unavailable: `${GITHUB_PR_TOOL} is only available in GitHub conversations.`,
    run: async (prFn, args: GithubPrArgs) => {
      const result = await prFn(args);
      return {
        content: [
          {
            type: "text" as const,
            text: result.updatedExisting
              ? `Branch already has PR #${result.number}: ${result.url}`
              : `Opened ${args.draft ? "draft " : ""}PR #${result.number}: ${result.url}`,
          },
        ],
        details: undefined,
      };
    },
  });

  return { tool, setGithubPrFunction: setFn };
}
