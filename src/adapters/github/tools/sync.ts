import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../../../harness/tools/host-fn-tool.js";

export const GITHUB_SYNC_TOOL = "github_sync";

const githubSyncSchema = Type.Object({
  branch: Type.Optional(
    Type.String({
      description:
        "Remote branch to fetch. Omit to fetch this PR's latest head (or the default " +
        "branch in a plain-issue conversation).",
    }),
  ),
});

import type { GithubSyncFn } from "../types.js";

export function createGithubSyncTool(): {
  tool: AgentTool<typeof githubSyncSchema>;
  setGithubSyncFunction: (fn: GithubSyncFn | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubSyncFn, typeof githubSyncSchema>({
    name: GITHUB_SYNC_TOOL,
    description:
      "Update ./repo from GitHub: fetches this PR's latest head (or the default branch, " +
      "or a named branch) and fast-forwards the checkout when that cannot lose your work; " +
      "otherwise it fetches to FETCH_HEAD and reports so you can merge or rebase yourself. " +
      "Only available in GitHub conversations.",
    parameters: githubSyncSchema,
    unavailable: `${GITHUB_SYNC_TOOL} is only available in GitHub conversations.`,
    run: async (syncFn, args) => {
      const report = await syncFn(args.branch);
      return {
        content: [{ type: "text" as const, text: report }],
        details: undefined,
      };
    },
  });

  return { tool, setGithubSyncFunction: setFn };
}
