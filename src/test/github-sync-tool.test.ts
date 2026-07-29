import { describe, expect, test, vi } from "vitest";
import { createGithubSyncTool } from "../adapters/github/tools/sync.js";

describe("github_sync tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubSyncTool();
    await expect(tool.execute("t1", {})).rejects.toThrow(/only available in GitHub conversations/);
  });

  test("delegates to the wired sync function and relays the report", async () => {
    const { tool, setGithubSyncFunction } = createGithubSyncTool();
    const sync = vi.fn().mockResolvedValue("Updated ./repo: branch pr-5 is now at abc123def456.");
    setGithubSyncFunction(sync);

    const result = await tool.execute("t1", { branch: "main" });

    expect(sync).toHaveBeenCalledWith("main");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Updated ./repo: branch pr-5 is now at abc123def456.",
    });
  });

  test("passes no branch through as undefined (PR-head default)", async () => {
    const { tool, setGithubSyncFunction } = createGithubSyncTool();
    const sync = vi.fn().mockResolvedValue("ok");
    setGithubSyncFunction(sync);
    await tool.execute("t1", {});
    expect(sync).toHaveBeenCalledWith(undefined);
  });

  test("unsetting the sync function disables the tool again", async () => {
    const { tool, setGithubSyncFunction } = createGithubSyncTool();
    setGithubSyncFunction(vi.fn().mockResolvedValue("ok"));
    setGithubSyncFunction(null);
    await expect(tool.execute("t1", {})).rejects.toThrow(/only available/);
  });
});
