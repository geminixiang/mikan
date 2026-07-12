import { describe, expect, test, vi } from "vitest";
import { createGithubToolPack } from "../src/adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "../src/adapters/github/types.js";

function mockOps(): PlatformGithubOps {
  return {
    pushAndCreatePr: vi.fn().mockResolvedValue({ number: 1, url: "https://example/pr/1" }),
    getChecks: vi.fn().mockResolvedValue([]),
    getJobLog: vi.fn().mockResolvedValue("log"),
  };
}

describe("createGithubToolPack", () => {
  test("exposes github_pr and github_checks tools", () => {
    const pack = createGithubToolPack(mockOps());
    expect(pack.tools.map((t) => t.name).toSorted()).toEqual(["github_checks", "github_pr"]);
  });

  test("bindRun enables tools only for github platform name", async () => {
    const ops = mockOps();
    const pack = createGithubToolPack(ops);
    const pr = pack.tools.find((t) => t.name === "github_pr")!;

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "slack" });
    await expect(pr.execute("id", { branch: "pi/x", title: "t" })).rejects.toThrow(
      /only available in GitHub/,
    );

    pack.bindRun({ conversationId: "GH_o_r_1", platformName: "github" });
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

    packA.bindRun({ conversationId: "GH_o_r_1", platformName: "github" });
    packB.bindRun({ conversationId: "GH_o_r_2", platformName: "github" });

    await prA.execute("id", { branch: "pi/a", title: "a" });
    expect(ops.pushAndCreatePr).toHaveBeenLastCalledWith("GH_o_r_1", {
      branch: "pi/a",
      title: "a",
    });

    // B rebinding to a non-github platform must not disable A's tools either.
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
