import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

const githubSyncSchema = Type.Object({
  branch: Type.Optional(
    Type.String({
      description:
        "Remote branch to fetch. Omit to fetch this PR's latest head (or the default " +
        "branch in a plain-issue conversation).",
    }),
  ),
});

export type GithubSyncFn = (branch?: string) => Promise<string>;

/**
 * The `github_sync` tool refreshes the conversation's ./repo clone — a
 * first-contact snapshot the sandbox cannot update itself (no credentials).
 * Host-side fetch with an ephemeral read token; it reports instead of moving
 * the checkout whenever that could lose the agent's local work.
 */
export function createGithubSyncTool(): {
  tool: AgentTool<typeof githubSyncSchema>;
  setGithubSyncFunction: (fn: GithubSyncFn | null) => void;
} {
  let syncFn: GithubSyncFn | null = null;

  const tool: AgentTool<typeof githubSyncSchema> = {
    name: "github_sync",
    label: "github_sync",
    description:
      "Update ./repo from GitHub: fetches this PR's latest head (or the default branch, " +
      "or a named branch) and fast-forwards the checkout when that cannot lose your work; " +
      "otherwise it fetches to FETCH_HEAD and reports so you can merge or rebase yourself. " +
      "Only available in GitHub conversations.",
    parameters: githubSyncSchema,
    execute: async (_toolCallId: string, args: { branch?: string }, signal?: AbortSignal) => {
      if (!syncFn) {
        throw new Error("github_sync is only available in GitHub conversations.");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const report = await syncFn(args.branch);
      return {
        content: [{ type: "text" as const, text: report }],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setGithubSyncFunction: (fn) => {
      syncFn = fn;
    },
  };
}
