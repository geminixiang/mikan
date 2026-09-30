import { describe, expect, test, vi } from "vitest";
import { createGithubToolPack } from "../adapters/github/tool-pack.js";
import type { GithubCapability, PlatformGithubOps } from "../adapters/github/types.js";

function mockOps(): PlatformGithubOps {
  return {
    pushAndCreatePr: vi.fn().mockResolvedValue({ number: 1, url: "https://example/pr/1" }),
    getChecks: vi.fn().mockResolvedValue([]),
    getJobLog: vi.fn().mockResolvedValue("log"),
    replyToReviewThread: vi.fn().mockResolvedValue({ url: "https://example/pr/1#r1" }),
    syncRepo: vi.fn().mockResolvedValue("synced"),
    readGithub: vi.fn().mockResolvedValue({ kind: "pr_files", files: [] }),
    manageIssue: vi.fn().mockResolvedValue("done"),
  };
}

const ALL_CAPABILITIES = new Set<GithubCapability>(["triage", "push"]);

describe("createGithubToolPack", () => {
  test("exposes every github tool when all capabilities are enabled", () => {
    const pack = createGithubToolPack(mockOps(), ALL_CAPABILITIES);
    expect(pack.tools.map((t) => t.name).toSorted()).toEqual([
      "github_checks",
      "github_issue",
      "github_pr",
      "github_read",
      "github_review_reply",
      "github_sync",
    ]);
  });

  test("withholds the push and triage tools unless their capability is enabled", () => {
    const names = (capabilities: GithubCapability[]) =>
      createGithubToolPack(mockOps(), new Set(capabilities)).tools.map((t) => t.name);
    expect(names([])).not.toContain("github_pr");
    expect(names([])).not.toContain("github_issue");
    expect(names(["push"])).toContain("github_pr");
    expect(names(["push"])).not.toContain("github_issue");
    expect(names(["triage"])).toContain("github_issue");
    expect(names(["triage"])).not.toContain("github_pr");
  });

  test("bindRun enables tools only for github platform name", async () => {
    const ops = mockOps();
    const pack = createGithubToolPack(ops, ALL_CAPABILITIES);
    const pr = pack.tools.find((t) => t.name === "github_pr")!;
    const reviewReply = pack.tools.find((t) => t.name === "github_review_reply")!;

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "slack" });
    await expect(pr.execute("id", { branch: "pi/x", title: "t" })).rejects.toThrow(
      /only available in GitHub/,
    );
    await expect(reviewReply.execute("id", { comment_id: 1, body: "x" })).rejects.toThrow(
      /only available in GitHub/,
    );

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "github" });
    await reviewReply.execute("id", { comment_id: 8001, body: "done" });
    expect(ops.replyToReviewThread).toHaveBeenCalledWith("GH_o_r_1", 8001, "done");

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "github" });
    const result = await pr.execute("id", { branch: "pi/x", title: "t" });
    expect(ops.pushAndCreatePr).toHaveBeenCalledWith("GH_o_r_1", {
      branch: "pi/x",
      title: "t",
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  test("packs from separate factory calls have independent bind state", async () => {
    const ops = mockOps();
    const packA = createGithubToolPack(ops, ALL_CAPABILITIES);
    const packB = createGithubToolPack(ops, ALL_CAPABILITIES);
    const prA = packA.tools.find((t) => t.name === "github_pr")!;
    const prB = packB.tools.find((t) => t.name === "github_pr")!;

    packA.bindRun({ conversationId: "GH_o_r_1", platformName: "github" });
    packB.bindRun({ conversationId: "GH_o_r_2", platformName: "github" });

    await prA.execute("id", { branch: "pi/a", title: "a" });
    expect(ops.pushAndCreatePr).toHaveBeenLastCalledWith("GH_o_r_1", {
      branch: "pi/a",
      title: "a",
    });

    packB.bindRun({ conversationId: "D123", platformName: "slack" });
    await prA.execute("id", { branch: "pi/a2", title: "a2" });
    expect(ops.pushAndCreatePr).toHaveBeenLastCalledWith("GH_o_r_1", {
      branch: "pi/a2",
      title: "a2",
    });
    await expect(prB.execute("id", { branch: "pi/b", title: "b" })).rejects.toThrow(
      /only available in GitHub/,
    );
  });
});
