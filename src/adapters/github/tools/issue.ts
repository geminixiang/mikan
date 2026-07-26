import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../../../tools/host-fn-tool.js";
import type { GithubIssueFn, GithubIssueRequest } from "../types.js";

export type { GithubIssueFn } from "../types.js";

const githubIssueSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add_labels"),
      Type.Literal("remove_label"),
      Type.Literal("add_assignees"),
      Type.Literal("remove_assignees"),
      Type.Literal("close"),
      Type.Literal("reopen"),
    ],
    { description: "Issue management action." },
  ),
  number: Type.Optional(
    Type.Number({
      description: "Issue/PR number in this repo; omit for this conversation's own.",
    }),
  ),
  labels: Type.Optional(
    Type.Array(Type.String(), { description: "add_labels: label names to add." }),
  ),
  label: Type.Optional(Type.String({ description: "remove_label: the label name to remove." })),
  assignees: Type.Optional(
    Type.Array(Type.String(), {
      description: "add_assignees / remove_assignees: GitHub logins.",
    }),
  ),
  state_reason: Type.Optional(
    Type.Union([Type.Literal("completed"), Type.Literal("not_planned")], {
      description: "close: why the issue is being closed.",
    }),
  ),
});

/**
 * The `github_issue` tool manages labels, assignees, and open/closed state of
 * issues in the conversation's repo (any issue number — triage). Host-side as
 * the App; wired per run and only for GitHub conversations.
 */
export function createGithubIssueTool(): {
  tool: AgentTool<typeof githubIssueSchema>;
  setGithubIssueFunction: (fn: GithubIssueFn | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubIssueFn, typeof githubIssueSchema>({
    name: "github_issue",
    description:
      "Manage issues in this repo: add/remove labels, add/remove assignees, close " +
      "(optionally with state_reason) or reopen. number defaults to this conversation's " +
      "issue; any issue number in this repo works for triage. Only available in GitHub " +
      "conversations.",
    parameters: githubIssueSchema,
    unavailable: "github_issue is only available in GitHub conversations.",
    run: async (issueFn, args) => {
      const report = await issueFn(args as GithubIssueRequest);
      return {
        content: [{ type: "text" as const, text: report }],
        details: undefined,
      };
    },
  });

  return { tool, setGithubIssueFunction: setFn };
}
