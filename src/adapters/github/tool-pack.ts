import { createGithubChecksTool } from "./tools/checks.js";
import { createGithubPrTool } from "./tools/pr.js";
import { createGithubIssueTool } from "./tools/issue.js";
import { createGithubReadTool } from "./tools/read.js";
import { createGithubReviewReplyTool } from "./tools/review-reply.js";
import { createGithubSubmitReviewTool } from "./tools/submit-review.js";
import { createGithubSyncTool } from "./tools/sync.js";
import type { PlatformToolPack } from "../../harness/tools/types.js";
import type { PlatformGithubOps } from "./types.js";

export function createGithubToolPack(ops: PlatformGithubOps): PlatformToolPack {
  const { tool: githubPrTool, setGithubPrFunction } = createGithubPrTool();
  const { tool: githubChecksTool, setGithubChecksFunction } = createGithubChecksTool();
  const { tool: githubReviewReplyTool, setGithubReviewReplyFunction } =
    createGithubReviewReplyTool();
  const { tool: githubSubmitReviewTool, setGithubSubmitReviewFunction } =
    createGithubSubmitReviewTool();
  const { tool: githubSyncTool, setGithubSyncFunction } = createGithubSyncTool();
  const { tool: githubReadTool, setGithubReadFunction } = createGithubReadTool();
  const { tool: githubIssueTool, setGithubIssueFunction } = createGithubIssueTool();

  return {
    tools: [
      githubPrTool,
      githubChecksTool,
      githubReviewReplyTool,
      githubSubmitReviewTool,
      githubSyncTool,
      githubReadTool,
      githubIssueTool,
    ],
    bindRun({ conversationId, platformName }) {
      if (platformName !== "github") {
        setGithubPrFunction(null);
        setGithubChecksFunction(null);
        setGithubReviewReplyFunction(null);
        setGithubSubmitReviewFunction(null);
        setGithubSyncFunction(null);
        setGithubReadFunction(null);
        setGithubIssueFunction(null);
        return;
      }
      setGithubPrFunction((request) => ops.pushAndCreatePr(conversationId, request));
      setGithubChecksFunction({
        getChecks: (branch) => ops.getChecks(conversationId, branch),
        getJobLog: (jobId) => ops.getJobLog(conversationId, jobId),
      });
      setGithubReviewReplyFunction((commentId, body) =>
        ops.replyToReviewThread(conversationId, commentId, body),
      );
      setGithubSubmitReviewFunction((body) => ops.submitReview(conversationId, body));
      setGithubSyncFunction((branch) => ops.syncRepo(conversationId, branch));
      setGithubReadFunction((request) => ops.readGithub(conversationId, request));
      setGithubIssueFunction((request) => ops.manageIssue(conversationId, request));
    },
  };
}
