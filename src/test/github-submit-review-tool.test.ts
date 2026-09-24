import { describe, expect, test, vi } from "vitest";
import { createGithubSubmitReviewTool } from "../adapters/github/tools/submit-review.js";

describe("github_submit_review tool", () => {
  test("requires a GitHub conversation", async () => {
    const { tool } = createGithubSubmitReviewTool();
    await expect(tool.execute("t1", { body: "review" })).rejects.toThrow(/only available/);
  });

  test("submits a formal review through the host function", async () => {
    const { tool, setGithubSubmitReviewFunction } = createGithubSubmitReviewTool();
    const submit = vi
      .fn()
      .mockResolvedValue({ url: "https://github.com/org/repo/pull/5#pullrequestreview-7" });
    setGithubSubmitReviewFunction(submit);
    const result = await tool.execute("t1", { body: "Please handle the edge case." });
    expect(submit).toHaveBeenCalledWith("Please handle the edge case.");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Submitted PR review: https://github.com/org/repo/pull/5#pullrequestreview-7",
    });
  });
});
