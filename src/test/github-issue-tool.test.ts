import { describe, expect, test, vi } from "vitest";
import { createGithubIssueTool } from "../adapters/github/tools/issue.js";

describe("github_issue tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubIssueTool();
    await expect(tool.execute("t1", { action: "close" })).rejects.toThrow(
      /only available in GitHub conversations/,
    );
  });

  test("delegates the full request to the wired function and relays the report", async () => {
    const { tool, setGithubIssueFunction } = createGithubIssueTool();
    const manage = vi.fn().mockResolvedValue("Added label(s) bug to #9.");
    setGithubIssueFunction(manage);

    const result = await tool.execute("t1", {
      action: "add_labels",
      number: 9,
      labels: ["bug"],
    });

    expect(manage).toHaveBeenCalledWith({ action: "add_labels", number: 9, labels: ["bug"] });
    expect(result.content[0]).toEqual({ type: "text", text: "Added label(s) bug to #9." });
  });

  test("unsetting the function disables the tool again", async () => {
    const { tool, setGithubIssueFunction } = createGithubIssueTool();
    setGithubIssueFunction(vi.fn().mockResolvedValue("ok"));
    setGithubIssueFunction(null);
    await expect(tool.execute("t1", { action: "reopen" })).rejects.toThrow(/only available/);
  });
});
