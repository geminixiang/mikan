import { describe, expect, test, vi } from "vitest";
import { createGithubReviewReplyTool } from "../src/adapters/github/tools/review-reply.js";

describe("github_review_reply tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubReviewReplyTool();
    await expect(tool.execute("t1", { comment_id: 8001, body: "hi" })).rejects.toThrow(
      /only available in GitHub conversations/,
    );
  });

  test("delegates to the wired reply function and reports the thread url", async () => {
    const { tool, setGithubReviewReplyFunction } = createGithubReviewReplyTool();
    const reply = vi
      .fn()
      .mockResolvedValue({ url: "https://github.com/octo/widgets/pull/5#discussion_r9002" });
    setGithubReviewReplyFunction(reply);

    const result = await tool.execute("t1", { comment_id: 8001, body: "renamed as asked" });

    expect(reply).toHaveBeenCalledWith(8001, "renamed as asked");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Replied in review thread rc-8001: https://github.com/octo/widgets/pull/5#discussion_r9002",
    });
  });

  test("unsetting the reply function disables the tool again", async () => {
    const { tool, setGithubReviewReplyFunction } = createGithubReviewReplyTool();
    setGithubReviewReplyFunction(vi.fn().mockResolvedValue({ url: "u" }));
    setGithubReviewReplyFunction(null);
    await expect(tool.execute("t1", { comment_id: 1, body: "x" })).rejects.toThrow(
      /only available/,
    );
  });
});
