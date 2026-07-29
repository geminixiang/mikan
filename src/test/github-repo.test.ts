import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  cloneRepo,
  GITHUB_PUSH_BRANCH_PATTERN,
  pushBranch,
  syncRepo,
} from "../adapters/github/repo.js";

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

  test("cloneRepo checks out the PR head as pr-<n> when the head branch is unknown", async () => {
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

  test("cloneRepo checks out the PR head under its real branch name when resolved", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
      prHeadBranch: "pi/fix-3",
    });

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pi/fix-3");
    expect(existsSync(join(cloneDir, "feature.txt"))).toBe(true);
  });

  test("cloneRepo falls back to pr-<n> for head branch names git would reject", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
      prHeadBranch: "--force-looking-name",
    });

    expect(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr-3");
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

  test("syncRepo fast-forwards a clean PR checkout to the new head", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    // New commit lands on the PR head after the clone.
    const seedDir = join(root, "seed");
    writeFileSync(join(seedDir, "more.txt"), "more\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-m", "pr update");
    git(seedDir, "push", originUrl, "HEAD:refs/pull/3/head");

    const result = await syncRepo({ dir: cloneDir, token: "unused", prNumber: 3 });

    expect(result.updatedCheckout).toBe(true);
    expect(result.target).toBe("pr-3");
    expect(existsSync(join(cloneDir, "more.txt"))).toBe(true);
    expect(gitPlain(cloneDir, "config", "--list")).not.toContain("extraheader");
  });

  test("syncRepo targets the real head branch name and updates it in place", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
      prHeadBranch: "pi/fix-3",
    });
    const seedDir = join(root, "seed");
    writeFileSync(join(seedDir, "more.txt"), "more\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-m", "pr update");
    git(seedDir, "push", originUrl, "HEAD:refs/pull/3/head");

    const result = await syncRepo({
      dir: cloneDir,
      token: "unused",
      prNumber: 3,
      prHeadBranch: "pi/fix-3",
    });

    expect(result.updatedCheckout).toBe(true);
    expect(result.target).toBe("pi/fix-3");
    expect(gitPlain(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pi/fix-3");
    expect(existsSync(join(cloneDir, "more.txt"))).toBe(true);
  });

  test("syncRepo migrates a clean legacy pr-<n> checkout to the real head branch name", async () => {
    // Clone made before the head branch name was resolvable: sits on pr-3.
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    expect(gitPlain(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr-3");

    const result = await syncRepo({
      dir: cloneDir,
      token: "unused",
      prNumber: 3,
      prHeadBranch: "pi/fix-3",
    });

    expect(result.updatedCheckout).toBe(true);
    expect(result.target).toBe("pi/fix-3");
    expect(gitPlain(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pi/fix-3");
  });

  test("syncRepo leaves a legacy pr-<n> checkout alone when it has agent commits", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    writeFileSync(join(cloneDir, "local.txt"), "local commit\n");
    gitPlain(cloneDir, "add", ".");
    gitPlain(cloneDir, "commit", "-m", "agent work on pr-3");

    const result = await syncRepo({
      dir: cloneDir,
      token: "unused",
      prNumber: 3,
      prHeadBranch: "pi/fix-3",
    });

    expect(result.updatedCheckout).toBe(false);
    expect(result.localCommits).toBe(1);
    expect(gitPlain(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pr-3");
  });

  test("syncRepo replaces a clean checkout after a force-pushed head", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    // Rewrite the PR head: amend away feature.txt into a different file.
    const seedDir = join(root, "seed");
    git(seedDir, "rm", "feature.txt");
    writeFileSync(join(seedDir, "rewritten.txt"), "rewritten\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "--amend", "-m", "rewritten head");
    git(seedDir, "push", "--force", originUrl, "HEAD:refs/pull/3/head");

    const result = await syncRepo({ dir: cloneDir, token: "unused", prNumber: 3 });

    expect(result.updatedCheckout).toBe(true);
    expect(existsSync(join(cloneDir, "rewritten.txt"))).toBe(true);
    expect(existsSync(join(cloneDir, "feature.txt"))).toBe(false);
  });

  test("syncRepo is fetch-only when the tree is dirty", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    writeFileSync(join(cloneDir, "wip.txt"), "uncommitted work\n");
    const seedDir = join(root, "seed");
    writeFileSync(join(seedDir, "more.txt"), "more\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-m", "pr update");
    git(seedDir, "push", originUrl, "HEAD:refs/pull/3/head");

    const result = await syncRepo({ dir: cloneDir, token: "unused", prNumber: 3 });

    expect(result.updatedCheckout).toBe(false);
    expect(result.dirty).toBe(true);
    expect(result.fetchedSha).toBeTruthy();
    // The agent's uncommitted file survives and the head did not move.
    expect(existsSync(join(cloneDir, "wip.txt"))).toBe(true);
    expect(existsSync(join(cloneDir, "more.txt"))).toBe(false);
  });

  test("syncRepo is fetch-only when the target branch has local commits", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    writeFileSync(join(cloneDir, "local.txt"), "local commit\n");
    // Commit as the agent does: with the clone's preconfigured bot identity.
    gitPlain(cloneDir, "add", ".");
    gitPlain(cloneDir, "commit", "-m", "agent work on pr-3");
    const localSha = gitPlain(cloneDir, "rev-parse", "HEAD");

    const result = await syncRepo({ dir: cloneDir, token: "unused", prNumber: 3 });

    expect(result.updatedCheckout).toBe(false);
    expect(result.localCommits).toBe(1);
    expect(gitPlain(cloneDir, "rev-parse", "HEAD")).toBe(localSha);
  });

  test("syncRepo is fetch-only when a different branch is checked out", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
      prNumber: 3,
    });
    git(cloneDir, "checkout", "-b", "pi/fix-3");

    const result = await syncRepo({ dir: cloneDir, token: "unused", prNumber: 3 });

    expect(result.updatedCheckout).toBe(false);
    expect(result.currentBranch).toBe("pi/fix-3");
    expect(gitPlain(cloneDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pi/fix-3");
  });

  test("syncRepo fetches a named branch and the default branch", async () => {
    await cloneRepo({
      url: originUrl,
      dir: cloneDir,
      token: "unused",
      botLogin: "mikan[bot]",
      botEmail: "bot@example.com",
    });
    const seedDir = join(root, "seed");
    git(seedDir, "checkout", "main");
    writeFileSync(join(seedDir, "main-update.txt"), "new on main\n");
    git(seedDir, "add", ".");
    git(seedDir, "commit", "-m", "main update");
    git(seedDir, "push", originUrl, "main");

    const result = await syncRepo({ dir: cloneDir, token: "unused", defaultBranch: "main" });

    expect(result.updatedCheckout).toBe(true);
    expect(existsSync(join(cloneDir, "main-update.txt"))).toBe(true);

    const named = await syncRepo({ dir: cloneDir, token: "unused", branch: "main" });
    expect(named.target).toBe("main");
  });

  test("branch pattern accepts nested names and rejects tricky ones", () => {
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/fix-42")).toBe(true);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/area/deep-fix")).toBe(true);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/-leading-dash")).toBe(false);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pizza/nope")).toBe(false);
    expect(GITHUB_PUSH_BRANCH_PATTERN.test("pi/has space")).toBe(false);
  });
});
