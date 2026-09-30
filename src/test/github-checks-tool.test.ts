import { describe, expect, test, vi } from "vitest";
import { createGithubChecksTool } from "../adapters/github/tools/checks.js";
import type { GithubChecksFns } from "../adapters/github/types.js";

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

  test("summarizes Actions jobs and commit statuses; skipped is not counted as failing", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    setGithubChecksFunction(
      makeFns({
        getChecks: vi.fn().mockResolvedValue([
          {
            id: 1,
            name: "test",
            status: "completed",
            conclusion: "success",
            url: "https://ci/1",
            source: "actions",
            outputSummary: null,
          },
          {
            id: 2,
            name: "lint",
            status: "completed",
            conclusion: "failure",
            url: "https://ci/2",
            source: "actions",
            outputSummary: "2 errors in src/x.py",
          },
          {
            id: 3,
            name: "dependabot",
            status: "completed",
            conclusion: "skipped",
            url: null,
            source: "actions",
            outputSummary: null,
          },
          {
            id: 4,
            name: "ci/external",
            status: "completed",
            conclusion: "failure",
            url: "https://cb/4",
            source: "status",
            outputSummary: null,
          },
          {
            id: 5,
            name: "build",
            status: "in_progress",
            conclusion: null,
            url: null,
            source: "actions",
            outputSummary: null,
          },
        ]),
      }),
    );

    const result = await tool.execute("t1", { branch: "pi/fix-5" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("5 check(s): 4 completed, 1 running, 2 failing");
    expect(text).toContain("✓ test: success [job 1] (https://ci/1)");
    expect(text).toContain("✗ lint: failure [job 2] (https://ci/2)");
    expect(text).toContain("↳ 2 errors in src/x.py");
    expect(text).toContain("− dependabot: skipped [job 3]");
    expect(text).toContain(
      "✗ ci/external: failure [commit status — logs not on GitHub] (https://cb/4)",
    );
    expect(text).toContain("… build: in_progress [job 5]");
  });

  test("passes the branch through and handles empty results", async () => {
    const { tool, setGithubChecksFunction } = createGithubChecksTool();
    const getChecks = vi.fn().mockResolvedValue([]);
    setGithubChecksFunction(makeFns({ getChecks }));

    const result = await tool.execute("t1", { branch: "pi/x" });
    expect(getChecks).toHaveBeenCalledWith("pi/x");
    expect((result.content[0] as { text: string }).text).toContain(
      "No CI jobs or commit statuses found",
    );
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
