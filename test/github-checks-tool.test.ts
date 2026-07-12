import { describe, expect, test, vi } from "vitest";
import { createGithubChecksTool } from "../src/tools/github-checks.js";

describe("github_checks tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubChecksTool();
    await expect(tool.execute("t1", {})).rejects.toThrow(/only available in GitHub/);
  });

  test("summarizes check runs with pass/fail markers", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    setGithubChecksFunction(
      vi.fn().mockResolvedValue([
        { name: "test", status: "completed", conclusion: "success", url: "https://ci/1" },
        { name: "lint", status: "completed", conclusion: "failure", url: "https://ci/2" },
        { name: "build", status: "in_progress", conclusion: null, url: null },
      ]),
    );

    const result = await tool.execute("t1", { branch: "pi/fix-5" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("3 check(s): 2 completed, 1 running, 1 failing");
    expect(text).toContain("✓ test: success (https://ci/1)");
    expect(text).toContain("✗ lint: failure (https://ci/2)");
    expect(text).toContain("… build: in_progress");
  });

  test("passes the branch through and handles empty results", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    const fn = vi.fn().mockResolvedValue([]);
    setGithubChecksFunction(fn);

    const result = await tool.execute("t1", { branch: "pi/x" });
    expect(fn).toHaveBeenCalledWith("pi/x");
    expect((result.content[0] as { text: string }).text).toContain("No check runs found");
  });
});
