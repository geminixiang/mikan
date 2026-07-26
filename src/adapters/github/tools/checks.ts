import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../../../tools/host-fn-tool.js";
export type { GithubChecksFns } from "../types.js";
import type { GithubCheckSummary, GithubChecksFns } from "../types.js";

const githubChecksSchema = Type.Object({
  branch: Type.Optional(
    Type.String({
      description:
        "Branch whose CI checks to read (e.g. a pi/<name> branch you pushed). " +
        "Omit in a pull-request conversation to read the PR head's checks.",
    }),
  ),
  job_id: Type.Optional(
    Type.Number({
      description:
        "A [job …] id from the summary output (GitHub Actions checks) — returns that " +
        "CI job's log (tail) instead of the summary, for diagnosing a failing check.",
    }),
  ),
  build_id: Type.Optional(
    Type.String({
      description:
        "A [build …] uuid from the summary output (Cloud Build checks) — returns that " +
        "build's log (tail) instead of the summary. Mutually exclusive with job_id.",
    }),
  ),
});

/** Conclusions that mean "this check did not pass and needs attention". */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "cancelled"]);

function formatCheckLine(run: GithubCheckSummary): string {
  const state = run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;
  const marker =
    run.conclusion === null
      ? "…"
      : FAILING_CONCLUSIONS.has(run.conclusion)
        ? "✗"
        : run.conclusion === "success"
          ? "✓"
          : "−";
  // GitHub Actions logs fetch via job_id; Cloud Build logs via build_id when
  // the host has GCP credentials. Other external CI keeps logs on its own
  // service, so advertising an id there would only invite doomed fetches.
  const handle =
    run.appSlug === "github-actions"
      ? `[job ${run.id}]`
      : run.buildLogAvailable && run.externalId
        ? `[build ${run.externalId}]`
        : `[external CI: ${run.appSlug ?? "unknown"} — logs not on GitHub]`;
  const line = `${marker} ${run.name}: ${state} ${handle}${run.url ? ` (${run.url})` : ""}`;
  const failed = run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion);
  return failed && run.outputSummary
    ? `${line}\n  ↳ ${run.outputSummary.replace(/\s*\n\s*/g, " ")}`
    : line;
}

/**
 * The `github_checks` tool reads CI check runs (GitHub Actions and other
 * check-reporting apps) for a branch or the conversation's PR head, and can
 * fetch one job's log tail so the agent can diagnose failures and iterate.
 * Read-only, host-side; wired per run and only for GitHub conversations.
 */
export function createGithubChecksTool(): {
  tool: AgentTool<typeof githubChecksSchema>;
  setGithubChecksFunction: (fns: GithubChecksFns | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<GithubChecksFns, typeof githubChecksSchema>({
    name: "github_checks",
    description:
      "Read CI status (check runs) for a branch you pushed with github_pr, or for this " +
      "conversation's pull request when branch is omitted. Pass job_id (a [job …] id, " +
      "GitHub Actions) or build_id (a [build …] uuid, Cloud Build) from the summary to " +
      "fetch that run's log. Other external CI checks keep logs on their own service: use " +
      "their summary/url, or reproduce the failure locally in ./repo. Only available in " +
      "GitHub conversations.",
    parameters: githubChecksSchema,
    unavailable: "github_checks is only available in GitHub conversations.",
    run: async (checksFns, args) => {
      if (args.job_id !== undefined && args.build_id !== undefined) {
        throw new Error("Pass either job_id or build_id, not both.");
      }

      if (args.job_id !== undefined) {
        const logText = await checksFns.getJobLog(args.job_id);
        return {
          content: [{ type: "text" as const, text: logText || "(empty log)" }],
          details: undefined,
        };
      }

      if (args.build_id !== undefined) {
        const logText = await checksFns.getBuildLog(args.build_id);
        return {
          content: [{ type: "text" as const, text: logText || "(empty log)" }],
          details: undefined,
        };
      }

      const runs = await checksFns.getChecks(args.branch);
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
        (run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion),
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
  });

  return { tool, setGithubChecksFunction: setFn };
}
