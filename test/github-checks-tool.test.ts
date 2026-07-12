import { describe, expect, test, vi } from "vitest";
import { createGithubChecksTool, type GithubChecksFns } from "../src/tools/github-checks.js";

function makeFns(overrides: Partial<GithubChecksFns> = {}): GithubChecksFns {
  return {
    getChecks: vi.fn().mockResolvedValue([]),
    getJobLog: vi.fn().mockResolvedValue(""),
    ...overrides,
  };
}

describe("github_checks tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubChecksTool();
    await expect(tool.execute("t1", {})).rejects.toThrow(/only available in GitHub/);
  });

  test("summarizes check runs; skipped is not counted as failing", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    setGithubChecksFunction(
      makeFns({
        getChecks: vi.fn().mockResolvedValue([
          { id: 1, name: "test", status: "completed", conclusion: "success", url: "https://ci/1" },
          { id: 2, name: "lint", status: "completed", conclusion: "failure", url: "https://ci/2" },
          { id: 3, name: "dependabot", status: "completed", conclusion: "skipped", url: null },
          { id: 4, name: "build", status: "in_progress", conclusion: null, url: null },
        ]),
      }),
    );

    const result = await tool.execute("t1", { branch: "pi/fix-5" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("4 check(s): 3 completed, 1 running, 1 failing");
    expect(text).toContain("✓ test: success [job 1] (https://ci/1)");
    expect(text).toContain("✗ lint: failure [job 2] (https://ci/2)");
    expect(text).toContain("− dependabot: skipped [job 3]");
    expect(text).toContain("… build: in_progress [job 4]");
  });

  test("passes the branch through and handles empty results", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    const getChecks = vi.fn().mockResolvedValue([]);
    setGithubChecksFunction(makeFns({ getChecks }));

    const result = await tool.execute("t1", { branch: "pi/x" });
    expect(getChecks).toHaveBeenCalledWith("pi/x");
    expect((result.content[0] as { text: string }).text).toContain("No check runs found");
  });

  test("job_id switches to log mode", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    const getJobLog = vi.fn().mockResolvedValue("FAILED tests/test_x.py::test_y - boom");
    setGithubChecksFunction(makeFns({ getJobLog }));

    const result = await tool.execute("t1", { job_id: 86659933598 });
    expect(getJobLog).toHaveBeenCalledWith(86659933598);
    expect((result.content[0] as { text: string }).text).toContain("FAILED tests/test_x.py");
  });
});
