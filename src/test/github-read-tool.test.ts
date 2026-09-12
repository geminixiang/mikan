import { describe, expect, test, vi } from "vitest";
import { createGithubReadTool } from "../adapters/github/tools/read.js";
import type { GithubReadResult } from "../adapters/github/types.js";

function makeTool(result: GithubReadResult) {
  const { tool, setGithubReadFunction } = createGithubReadTool();
  const read = vi.fn().mockResolvedValue(result);
  setGithubReadFunction(read);
  return { tool, read };
}

async function textOf(tool: ReturnType<typeof makeTool>["tool"], args: object): Promise<string> {
  const result = await tool.execute("t1", args as never);
  return (result.content[0] as { text: string }).text;
}

describe("github_read tool", () => {
  test("reports itself unavailable outside GitHub conversations", async () => {
    const { tool } = createGithubReadTool();
    await expect(tool.execute("t1", { action: "pr" })).rejects.toThrow(
      /only available in GitHub conversations/,
    );
  });

  test("pr action renders metadata with diff stats", async () => {
    const { tool, read } = makeTool({
      kind: "pr",
      pr: {
        number: 5,
        html_url: "u",
        title: "Fix widget",
        state: "open",
        draft: true,
        head: { ref: "pi/fix-5", sha: "abc" },
        base: { ref: "main" },
        changed_files: 3,
        additions: 40,
        deletions: 12,
        user: { login: "alice", type: "User" },
        body: "Fixes the widget.",
      },
    });

    const text = await textOf(tool, { action: "pr" });
    expect(read).toHaveBeenCalledWith({ action: "pr" });
    expect(text).toBe(
      "PR #5: Fix widget [open, draft]\npi/fix-5 → main | 3 files, +40 -12\nauthor: @alice\nFixes the widget.",
    );
  });

  test("pr_files action lists one line per file", async () => {
    const { tool } = makeTool({
      kind: "pr_files",
      files: [
        { filename: "src/a.ts", status: "modified", additions: 5, deletions: 2 },
        { filename: "src/b.ts", status: "added", additions: 20, deletions: 0 },
      ],
    });

    const text = await textOf(tool, { action: "pr_files", number: 7 });
    expect(text).toContain("2 changed file(s):");
    expect(text).toContain("src/a.ts +5 -2");
    expect(text).toContain("src/b.ts +20 -0");
  });

  test("pr_reviews renders review states and rc- thread ids", async () => {
    const { tool } = makeTool({
      kind: "pr_reviews",
      reviews: [
        {
          id: 1,
          user: { login: "bob", type: "User" },
          state: "CHANGES_REQUESTED",
          body: "needs work",
        },
        { id: 2, user: { login: "carol", type: "User" }, state: "PENDING", body: null },
      ],
      threads: [
        {
          id: 8001,
          body: "rename this",
          user: { login: "bob", type: "User" },
          created_at: "c",
          updated_at: "u",
          pull_request_url: "p",
          path: "src/widget.ts",
          line: 42,
          diff_hunk: "",
        },
        {
          id: 8002,
          body: "done?",
          user: { login: "bob", type: "User" },
          created_at: "c",
          updated_at: "u",
          pull_request_url: "p",
          path: "src/widget.ts",
          line: 42,
          diff_hunk: "",
          in_reply_to_id: 8001,
        },
      ],
    });

    const text = await textOf(tool, { action: "pr_reviews" });
    expect(text).toContain("@bob: CHANGES_REQUESTED — needs work");
    expect(text).not.toContain("PENDING");
    expect(text).toContain("rc-8001 src/widget.ts:42 @bob (1 reply): rename this");
    expect(text).not.toContain("rc-8002");
  });

  test("list renders filtered issues and forwards filter params", async () => {
    const { tool, read } = makeTool({
      kind: "list",
      issues: [
        {
          id: 1,
          number: 9,
          title: "Bug A",
          body: null,
          user: { login: "a", type: "User" },
          created_at: "c",
          updated_at: "u",
          state: "open",
          labels: [{ name: "bug" }],
        },
        {
          id: 2,
          number: 10,
          title: "Feature B",
          body: null,
          user: { login: "a", type: "User" },
          created_at: "c",
          updated_at: "u",
          state: "open",
          pull_request: {},
        },
      ],
    });

    const text = await textOf(tool, { action: "list", labels: "bug", state: "open" });
    expect(read).toHaveBeenCalledWith({ action: "list", labels: "bug", state: "open" });
    expect(text).toBe("#9 [open issue] Bug A (bug)\n#10 [open PR] Feature B");
  });

  test("truncates oversized bodies", async () => {
    const { tool } = makeTool({
      kind: "issue",
      issue: {
        id: 1,
        number: 5,
        title: "Big",
        body: "x".repeat(5000),
        user: { login: "a", type: "User" },
        created_at: "c",
        updated_at: "u",
        state: "open",
      },
    });

    const text = await textOf(tool, { action: "issue" });
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain("…");
  });

  test.each([
    [
      { kind: "pr", pr: { number: 1, html_url: "u" } },
      "PR #1:  [unknown]\n? → ? | ? files, +? -?\n(no description)",
    ],
    [
      {
        kind: "pr",
        pr: {
          number: 1,
          html_url: "u",
          state: "closed",
          title: "Done",
          merged: true,
          draft: true,
          mergeable_state: "clean",
          head: { ref: "", sha: "s" },
          base: { ref: "main" },
          additions: 0,
          deletions: 0,
          changed_files: 0,
          user: { login: "a", type: "User" },
          body: " ",
        },
      },
      "PR #1: Done [closed, draft, merged, mergeable_state: clean]\n → main | 0 files, +0 -0\nauthor: @a\n ",
    ],
    [{ kind: "pr_files", files: [] }, "No changed files."],
    [
      { kind: "pr_files", files: [{ filename: "a", status: "added", additions: 0, deletions: 0 }] },
      "1 changed file(s):\nadded    a +0 -0",
    ],
    [{ kind: "comments", comments: [] }, "No comments."],
    [{ kind: "list", issues: [] }, "No matching issues."],
    [
      { kind: "pr_reviews", reviews: [], threads: [] },
      "No submitted reviews.\n\nNo inline review threads.",
    ],
  ] satisfies Array<[GithubReadResult, string]>)(
    "preserves exact output for %j",
    async (result, expected) => {
      expect(await textOf(makeTool(result).tool, { action: result.kind })).toBe(expected);
    },
  );

  test("reviews preserve whitespace, truncation, root order, null lines and reply counts", async () => {
    const root = {
      id: 1,
      body: "x".repeat(301),
      user: { login: "a", type: "User" },
      created_at: "c",
      updated_at: "u",
      pull_request_url: "p",
      path: "a.ts",
      line: null,
      diff_hunk: "",
    };
    const { tool } = makeTool({
      kind: "pr_reviews",
      reviews: [
        { id: 1, user: root.user, state: "PENDING", body: "hidden" },
        { id: 2, user: root.user, state: "APPROVED", body: " \n " },
        { id: 3, user: root.user, state: "COMMENTED", body: " " + "r".repeat(300) },
      ],
      threads: [
        root,
        { ...root, id: 2, line: 0, body: "zero" },
        { ...root, id: 3, body: "one" },
        { ...root, id: 4, in_reply_to_id: 1 },
        { ...root, id: 5, in_reply_to_id: 1 },
        { ...root, id: 6, in_reply_to_id: 3 },
        { ...root, id: 7, in_reply_to_id: 999 },
      ],
    });
    expect(await textOf(tool, { action: "pr_reviews" })).toBe(
      `Reviews:\n@a: APPROVED\n@a: COMMENTED — ${" " + "r".repeat(299)}…\n\nInline threads (reply with github_review_reply):\nrc-1 a.ts @a (2 replies): ${"x".repeat(300)}…\nrc-2 a.ts:0 @a: zero\nrc-3 a.ts @a (1 reply): one`,
    );
  });

  test("issue and comment text preserve exact truncation boundaries", async () => {
    const issue = {
      id: 1,
      number: 5,
      title: "Big",
      body: "x".repeat(1000),
      user: { login: "a", type: "User" },
      created_at: "c",
      updated_at: "u",
    };
    expect(await textOf(makeTool({ kind: "issue", issue }).tool, { action: "issue" })).toBe(
      `#5: Big [unknown]\nauthor: @a\n${issue.body}`,
    );
    expect(
      await textOf(
        makeTool({
          kind: "issue",
          issue: {
            ...issue,
            body: null,
            pull_request: {},
            labels: [{ name: "bug" }, { name: "help" }],
            assignees: [{ login: "b", type: "User" }],
          },
        }).tool,
        { action: "issue" },
      ),
    ).toBe("#5: Big [unknown, PR]\nlabels: bug, help\nassignees: @b\nauthor: @a\n(no body)");
    const comment = {
      id: 1,
      user: issue.user,
      body: "x".repeat(500),
      created_at: "c",
      updated_at: "u",
      issue_url: "i",
    };
    expect(
      await textOf(
        makeTool({
          kind: "comments",
          comments: [comment, { ...comment, id: 2, body: comment.body + "y" }],
        }).tool,
        { action: "comments" },
      ),
    ).toBe(`@a (c): ${comment.body}\n@a (c): ${comment.body}…`);
  });

  test("unsetting the read function disables the tool again", async () => {
    const { tool, setGithubReadFunction } = createGithubReadTool();
    setGithubReadFunction(vi.fn());
    setGithubReadFunction(null);
    await expect(tool.execute("t1", { action: "pr" })).rejects.toThrow(/only available/);
  });
});
