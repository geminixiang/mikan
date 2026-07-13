import { createGithubChecksTool } from "./tools/checks.js";
import { createGithubPrTool } from "./tools/pr.js";
import { createGithubIssueTool } from "./tools/issue.js";
import { createGithubReadTool } from "./tools/read.js";
import { createGithubReviewReplyTool } from "./tools/review-reply.js";
import { createGithubSyncTool } from "./tools/sync.js";
import type { PlatformToolPack } from "../../tools/types.js";
import type { PlatformGithubOps } from "./types.js";

/**
 * GitHub host-side capability pack — one tool per module under `tools/`:
 * github_pr, github_checks, github_review_reply, github_sync, github_read,
 * github_issue.
 *
 * These tools never run in the sandbox; they call PlatformGithubOps which
 * mints short-lived installation tokens on the host. The pack is only
 * constructed when the GitHub bot is configured; bindRun enables the tools
 * only for github-named conversations so multi-platform processes stay safe.
 */
export function createGithubToolPack(ops: PlatformGithubOps): PlatformToolPack {
  const { tool: githubPrTool, setGithubPrFunction } = createGithubPrTool();
  const { tool: githubChecksTool, setGithubChecksFunction } = createGithubChecksTool();
  const { tool: githubReviewReplyTool, setGithubReviewReplyFunction } =
    createGithubReviewReplyTool();
  const { tool: githubSyncTool, setGithubSyncFunction } = createGithubSyncTool();
  const { tool: githubReadTool, setGithubReadFunction } = createGithubReadTool();
  const { tool: githubIssueTool, setGithubIssueFunction } = createGithubIssueTool();

  return {
    tools: [
      githubPrTool,
      githubChecksTool,
      githubReviewReplyTool,
      githubSyncTool,
      githubReadTool,
      githubIssueTool,
    ],
    bindRun({ conversationId, platformName }) {
      if (platformName !== "github") {
        setGithubPrFunction(null);
        setGithubChecksFunction(null);
        setGithubReviewReplyFunction(null);
        setGithubSyncFunction(null);
        setGithubReadFunction(null);
        setGithubIssueFunction(null);
        return;
      }
      setGithubPrFunction((request) => ops.pushAndCreatePr(conversationId, request));
      setGithubChecksFunction({
        getChecks: (branch) => ops.getChecks(conversationId, branch),
        getJobLog: (jobId) => ops.getJobLog(conversationId, jobId),
        getBuildLog: (buildId) => ops.getBuildLog(conversationId, buildId),
      });
      setGithubReviewReplyFunction((commentId, body) =>
        ops.replyToReviewThread(conversationId, commentId, body),
      );
      setGithubSyncFunction((branch) => ops.syncRepo(conversationId, branch));
      setGithubReadFunction((request) => ops.readGithub(conversationId, request));
      setGithubIssueFunction((request) => ops.manageIssue(conversationId, request));
    },
  };
}
