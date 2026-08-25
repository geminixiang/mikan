import { describe, expect, test, vi } from "vitest";
import { createGithubToolPack } from "../adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "../adapters/github/types.js";

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

describe("createGithubToolPack", () => {
  test("exposes the github tools", () => {
    const pack = createGithubToolPack(mockOps());
    expect(pack.tools.map((t) => t.name).toSorted()).toEqual([
      "github_checks",
      "github_issue",
      "github_pr",
      "github_read",
      "github_review_reply",
      "github_sync",
    ]);
  });

  test("bindRun enables tools only for github platform name", async () => {
    const ops = mockOps();
    const pack = createGithubToolPack(ops);
    const pr = pack.tools.find((t) => t.name === "github_pr")!;
    const reviewReply = pack.tools.find((t) => t.name === "github_review_reply")!;

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "slack", userId: "U1" });
    await expect(pr.execute("id", { branch: "pi/x", title: "t" })).rejects.toThrow(
      /only available in GitHub/,
    );
    await expect(reviewReply.execute("id", { comment_id: 1, body: "x" })).rejects.toThrow(
      /only available in GitHub/,
    );

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "github", userId: "U1" });
    await reviewReply.execute("id", { comment_id: 8001, body: "done" });
    expect(ops.replyToReviewThread).toHaveBeenCalledWith("GH_o_r_1", 8001, "done");

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "github", userId: "U1" });
    const result = await pr.execute("id", { branch: "pi/x", title: "t" });
    expect(ops.pushAndCreatePr).toHaveBeenCalledWith("GH_o_r_1", {
      branch: "pi/x",
      title: "t",
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  test("packs from separate factory calls have independent bind state", async () => {
    // Packs are injected as factories and instantiated per runner: bind state
    // must never leak across concurrently running conversations.
    const ops = mockOps();
    const packA = createGithubToolPack(ops);
    const packB = createGithubToolPack(ops);
    const prA = packA.tools.find((t) => t.name === "github_pr")!;
    const prB = packB.tools.find((t) => t.name === "github_pr")!;

    packA.bindRun({ conversationId: "GH_o_r_1", platformName: "github", userId: "U1" });
    packB.bindRun({ conversationId: "GH_o_r_2", platformName: "github", userId: "U1" });

    await prA.execute("id", { branch: "pi/a", title: "a" });
    expect(ops.pushAndCreatePr).toHaveBeenLastCalledWith("GH_o_r_1", {
      branch: "pi/a",
      title: "a",
    });

    // B rebinding to a non-github platform must not disable A's tools either.
    packB.bindRun({ conversationId: "D123", platformName: "slack", userId: "U1" });
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
