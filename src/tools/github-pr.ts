import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { GithubPrRequest, GithubPrResult } from "../adapters/github/types.js";

const githubPrSchema = Type.Object({
  branch: Type.String({
    description:
      'Local branch inside ./repo to push. Must be named pi/<something> (e.g. "pi/fix-42"); the default branch is never pushable.',
  }),
  title: Type.String({ description: "Pull request title." }),
  body: Type.Optional(Type.String({ description: "Pull request description (Markdown)." })),
  base: Type.Optional(
    Type.String({ description: "Target branch; defaults to the repository's default branch." }),
  ),
  draft: Type.Optional(Type.Boolean({ description: "Open as a draft pull request." })),
});

type GithubPrArgs = GithubPrRequest;

/**
 * The `github_pr` tool pushes a branch the agent prepared in the
 * conversation's ./repo clone and opens a pull request as the GitHub App.
 * The push and API calls run host-side with an ephemeral repo-scoped token;
 * the sandbox never holds credentials. Wired per run via the setter, and only
 * for GitHub conversations.
 */
export function createGithubPrTool(): {
  tool: AgentTool<typeof githubPrSchema>;
  setGithubPrFunction: (fn: ((request: GithubPrRequest) => Promise<GithubPrResult>) | null) => void;
} {
  let prFn: ((request: GithubPrRequest) => Promise<GithubPrResult>) | null = null;

  const tool: AgentTool<typeof githubPrSchema> = {
    name: "github_pr",
    label: "github_pr",
    description:
      "Push a pi/<name> branch you committed inside ./repo and open a GitHub pull request " +
      "(or draft) for it. Only available in GitHub issue/PR conversations. You cannot push " +
      "to the default branch and you cannot merge — humans review and merge the PR.",
    parameters: githubPrSchema,
    execute: async (_toolCallId: string, args: GithubPrArgs, signal?: AbortSignal) => {
      if (!prFn) {
        throw new Error("github_pr is only available in GitHub conversations.");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const result = await prFn(args);
      return {
        content: [
          {
            type: "text" as const,
            text: result.updatedExisting
              ? `Pushed to existing PR #${result.number}: ${result.url}`
              : `Opened ${args.draft ? "draft " : ""}PR #${result.number}: ${result.url}`,
          },
        ],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setGithubPrFunction: (fn) => {
      prFn = fn;
    },
  };
}
