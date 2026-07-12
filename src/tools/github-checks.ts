import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { GithubCheckSummary } from "../adapter.js";

const githubChecksSchema = Type.Object({
  branch: Type.Optional(
    Type.String({
      description:
        "Branch whose CI checks to read (e.g. a pi/<name> branch you pushed). " +
        "Omit in a pull-request conversation to read the PR head's checks.",
    }),
  ),
});

function formatCheckLine(run: GithubCheckSummary): string {
  const state = run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;
  const marker = run.conclusion === "success" ? "✓" : run.conclusion ? "✗" : "…";
  return `${marker} ${run.name}: ${state}${run.url ? ` (${run.url})` : ""}`;
}

/**
 * The `github_checks` tool reads CI check runs (GitHub Actions and other
 * check-reporting apps) for a branch or the conversation's PR head, so the
 * agent can see whether its pushed changes pass and iterate on failures.
 * Read-only, host-side; wired per run and only for GitHub conversations.
 */
export function createGithubChecksTool(): {
  tool: AgentTool<typeof githubChecksSchema>;
  setGithubChecksFunction: (
    fn: ((branch?: string) => Promise<GithubCheckSummary[]>) | null,
  ) => void;
} {
  let checksFn: ((branch?: string) => Promise<GithubCheckSummary[]>) | null = null;

  const tool: AgentTool<typeof githubChecksSchema> = {
    name: "github_checks",
    label: "github_checks",
    description:
      "Read CI status (check runs) for a branch you pushed with github_pr, or for this " +
      "conversation's pull request when branch is omitted. Use it after opening a PR to " +
      "verify CI, and re-run it (optionally after waiting) while checks are in progress.",
    parameters: githubChecksSchema,
    execute: async (_toolCallId: string, args: { branch?: string }, signal?: AbortSignal) => {
      if (!checksFn) {
        throw new Error("github_checks is only available in GitHub conversations.");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const runs = await checksFn(args.branch);
      if (runs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No check runs found — CI may not have started yet; try again shortly.",
            },
          ],
          details: undefined,
        };
      }
      const completed = runs.filter((run) => run.status === "completed");
      const failing = completed.filter(
        (run) => run.conclusion !== "success" && run.conclusion !== "neutral",
      );
      const summary = `${runs.length} check(s): ${completed.length} completed, ${runs.length - completed.length} running, ${failing.length} failing`;
      return {
        content: [
          {
            type: "text" as const,
            text: [summary, ...runs.map(formatCheckLine)].join("\n"),
          },
        ],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setGithubChecksFunction: (fn) => {
      checksFn = fn;
    },
  };
}
