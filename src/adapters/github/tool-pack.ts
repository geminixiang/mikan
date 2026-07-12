import { createGithubChecksTool } from "../../tools/github-checks.js";
import { createGithubPrTool } from "../../tools/github-pr.js";
import type { PlatformToolPack } from "../../tools/types.js";
import type { PlatformGithubOps } from "./types.js";

/**
 * GitHub host-side capability pack: github_pr + github_checks.
 *
 * These tools never run in the sandbox; they call PlatformGithubOps which
 * mints short-lived installation tokens on the host. The pack is only
 * constructed when the GitHub bot is configured; bindRun enables the tools
 * only for github-named conversations so multi-platform processes stay safe.
 */
export function createGithubToolPack(ops: PlatformGithubOps): PlatformToolPack {
  const { tool: githubPrTool, setGithubPrFunction } = createGithubPrTool();
  const { tool: githubChecksTool, setGithubChecksFunction } = createGithubChecksTool();

  return {
    tools: [githubPrTool, githubChecksTool],
    bindRun({ conversationId, platformName }) {
      if (platformName !== "github") {
        setGithubPrFunction(null);
        setGithubChecksFunction(null);
        return;
      }
      setGithubPrFunction((request) => ops.pushAndCreatePr(conversationId, request));
      setGithubChecksFunction({
        getChecks: (branch) => ops.getChecks(conversationId, branch),
        getJobLog: (jobId) => ops.getJobLog(conversationId, jobId),
      });
    },
  };
}
