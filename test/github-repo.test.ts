import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cloneRepo, GITHUB_PUSH_BRANCH_PATTERN, pushBranch } from "../src/adapters/github/repo.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args],
    { cwd, encoding: "utf-8" },
  ).trim();
}

/** Read git state without the fixture-identity `-c` overrides. */
function gitPlain(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("github repo git operations", () => {
  let root: string;
  let originDir: string;
  let originUrl: string;
  let cloneDir: string;

  beforeEach(() => {
    root = join(tmpdir(), `mikan-github-repo-${Date.now()}-${Math.random()}`);
    originDir = join(root, "origin.git");
    cloneDir = join(root, "clone", "repo");
    mkdirSync(originDir, { recursive: true });
    git(originDir, "init", "--bare", "--initial-branch=main", ".");
    originUrl = `file://${originDir}`;

    // Seed origin: one commit on main, plus a PR head ref (refs/pull/3/head).
    const seedDir = join(root, "seed");
    mkdirSync(seedDir);
    git(seedDir, "init", "--initial-branch=main", ".");
    writeFileSync(join(seedDir, "README.md"), "hello\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-m", "initial");
    git(seedDir, "push", originUrl, "main");
    writeFileSync(join(seedDir, "feature.txt"), "pr change\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-m", "pr head");
    git(seedDir, "push", originUrl, "HEAD:refs/pull/3/head");
  });

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  test("cloneRepo clones shallowly and preconfigures the bot identity", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused-for-file-remotes",
      botLogin: "mikan[bot]",
      botEmail: "999+mikan[bot]@users.noreply.github.com",
    });

    expect(existsSync(join(cloneDir, "README.md"))).toBe(true);
    expect(gitPlain(cloneDir, "config", "user.name")).toBe("mikan[bot]");
    expect(gitPlain(cloneDir, "config", "user.email")).toBe(
      "999+mikan[bot]@users.noreply.github.com",
    );
    // The ephemeral token must not be persisted anywhere in git config.
    expect(gitPlain(cloneDir, "config", "--list")).not.toContain("extraheader");
  });

  test("cloneRepo checks out the PR head as pr-<n> for PR conversations", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr-3");
    expect(existsSync(join(cloneDir, "feature.txt"))).toBe(true);
  });

  test("pushBranch pushes a pi/* branch to origin", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
    });
    writeFileSync(join(cloneDir, "fix.txt"), "fixed\n");
    git(cloneDir, "checkout", "-b", "pi/fix-3");
    git(cloneDir, "add", ".");
    git(cloneDir, "commit", "-m", "fix");

    await pushBranch({ dir: cloneDir, branch: "pi/fix-3", token: "unused" });

    expect(git(originDir, "rev-parse", "--verify", "refs/heads/pi/fix-3")).toBeTruthy();
  });

  test("pushBranch refuses non-pi branches and missing branches", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
    });

    for (const branch of ["main", "feature/x", "pi", "pi/", "-pi/x"]) {
      await expect(pushBranch({ dir: cloneDir, branch, token: "unused" })).rejects.toThrow(
        /Refusing to push/,
      );
    }
    await expect(pushBranch({ dir: cloneDir, branch: "pi/nope", token: "unused" })).rejects.toThrow(
      /does not exist/,
    );
  });

  test("branch pattern accepts nested names and rejects tricky ones", () => {
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/fix-42")).toBe(true);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/area/deep-fix")).toBe(true);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/-leading-dash")).toBe(false);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pizza/nope")).toBe(false);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/has space")).toBe(false);
  });
});
