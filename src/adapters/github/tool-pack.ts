import { createGithubChecksTool } from "./tools/checks.js";
import { createGithubPrTool } from "./tools/pr.js";
import { createGithubIssueTool } from "./tools/issue.js";
import { createGithubReadTool } from "./tools/read.js";
import { createGithubReviewReplyTool } from "./tools/review-reply.js";
import type { PlatformToolPack } from "../../harness/tools/types.js";
import type { GithubCapability, PlatformGithubOps } from "./types.js";

export function createGithubToolPack(
  ops: PlatformGithubOps,
  capabilities: ReadonlySet<GithubCapability>,
): PlatformToolPack {
  const { tool: githubPrTool, setGithubPrFunction } = createGithubPrTool();
  const { tool: githubChecksTool, setGithubChecksFunction } = createGithubChecksTool();
  const { tool: githubReviewReplyTool, setGithubReviewReplyFunction } =
    createGithubReviewReplyTool();
  const { tool: githubReadTool, setGithubReadFunction } = createGithubReadTool();
  const { tool: githubIssueTool, setGithubIssueFunction } = createGithubIssueTool();

  return {
    tools: [
      ...(capabilities.has("push") ? [githubPrTool] : []),
      githubChecksTool,
      githubReviewReplyTool,
      githubReadTool,
      ...(capabilities.has("triage") ? [githubIssueTool] : []),
    ],
    bindRun({ conversationId, platformName }) {
      if (platformName !== "github") {
        setGithubPrFunction(null);
        setGithubChecksFunction(null);
        setGithubReviewReplyFunction(null);
        setGithubReadFunction(null);
        setGithubIssueFunction(null);
        return;
      }
      setGithubPrFunction((request) => ops.createPullRequest(conversationId, request));
      setGithubChecksFunction({
        getChecks: (branch) => ops.getChecks(conversationId, branch),
        getJobLog: (jobId) => ops.getJobLog(conversationId, jobId),
      });
      setGithubReviewReplyFunction((commentId, body) =>
        ops.replyToReviewThread(conversationId, commentId, body),
      );
      setGithubReadFunction((request) => ops.readGithub(conversationId, request));
      setGithubIssueFunction((request) => ops.manageIssue(conversationId, request));
    },
  };
}
