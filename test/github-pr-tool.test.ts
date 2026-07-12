import { describe, expect, test, vi } from "vitest";
import { createGithubPrTool } from "../src/tools/github-pr.js";

describe("github_pr tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubPrTool();
    await expect(tool.execute("t1", { branch: "pi/x", title: "t" })).rejects.toThrow(
      /only available in GitHub conversations/,
    );
  });

  test("delegates to the wired creator and reports the PR url", async () => {
    const { tool, setGithubPrFunction } = createGithubPrTool();
    const creator = vi
      .fn()
      .mockResolvedValue({ number: 7, url: "https://github.com/octo/widgets/pull/7" });
    setGithubPrFunction(creator);

    const result = await tool.execute("t1", {
      branch: "pi/fix-5",
      title: "Fix",
      body: "Closes #5",
      draft: true,
    });

    expect(creator).toHaveBeenCalledWith({
      branch: "pi/fix-5",
      title: "Fix",
      body: "Closes #5",
      draft: true,
    });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Opened draft PR #7: https://github.com/octo/widgets/pull/7",
    });
  });

  test("unsetting the creator disables the tool again", async () => {
    const { tool, setGithubPrFunction } = createGithubPrTool();
    setGithubPrFunction(vi.fn().mockResolvedValue({ number: 1, url: "u" }));
    setGithubPrFunction(null);
    await expect(tool.execute("t1", { branch: "pi/x", title: "t" })).rejects.toThrow(
      /only available/,
    );
  });
});
