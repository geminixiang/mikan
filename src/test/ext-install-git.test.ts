import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runExtCommand } from "../cli/ext.js";
import { materializeSource } from "../packages/index.js";
import { isGitSourceString, parseSource } from "../packages/index.js";

describe("isGitSourceString", () => {
  test("recognizes git source spellings", () => {
    expect(isGitSourceString("https://github.com/owner/repo.git#dir/ext")).toBe(true);
    expect(isGitSourceString("github:owner/repo#ext")).toBe(true);
    expect(isGitSourceString("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitSourceString("file:///somewhere/repo")).toBe(true);
  });

  test("local paths are not git sources", () => {
    expect(isGitSourceString("./agent-pm")).toBe(false);
    expect(isGitSourceString("/abs/agent-pm")).toBe(false);
  });

  test("parseSource rejects unsafe #subpath values", () => {
    for (const subpath of ["../../outside", "/outside", String.raw`..\outside`]) {
      expect(() => parseSource(`https://github.com/owner/repo.git#${subpath}`)).toThrow(
        /must be a relative path/,
      );
    }
  });
});

describe("mikan ext install from git", () => {
  let repo: string;
  let stateDir: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mikan-ext-git-repo-"));
    stateDir = mkdtempSync(join(tmpdir(), "mikan-ext-git-state-"));
    // A monorepo-like layout: the extension lives at a subpath.
    const extDir = join(repo, "examples", "agent-pm");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.mjs"), "export default function activate() {}");
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "agent-pm",
        version: "0.1.0",
        mikan: { extensions: ["./index.mjs"] },
      }),
    );
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("clones a git source with #subpath and installs it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runExtCommand([
      "install",
      `file://${repo}#examples/agent-pm`,
      "--global",
      "--state-dir",
      stateDir,
    ]);
    expect(code).toBe(0);
    expect(existsSync(join(stateDir, "global", "extensions", "agent-pm", "index.mjs"))).toBe(true);
  });

  test("materializeSource rejects subpaths through symlinks leaving the clone", () => {
    const outside = mkdtempSync(join(tmpdir(), "mikan-ext-git-outside-"));
    try {
      symlinkSync(outside, join(repo, "examples", "outside-link"), "dir");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "symlink"],
        { cwd: repo },
      );

      expect(() =>
        materializeSource(`file://${repo}#examples/outside-link`, {
          scope: "global",
          stateDir,
          mode: "fetch",
        }),
      ).toThrow(/Subpath escapes repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("reinstall over an existing extension updates it (reports Reinstalled)", async () => {
    const log: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void log.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = `file://${repo}#examples/agent-pm`;
    await runExtCommand(["install", source, "--global", "--state-dir", stateDir]);
    log.length = 0;
    const code = await runExtCommand(["install", source, "--global", "--state-dir", stateDir]);
    expect(code).toBe(0);
    expect(log.join("\n")).toMatch(/Reinstalled/);
  });

  test("reinstall preserves extension data", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = `file://${repo}#examples/agent-pm`;
    await runExtCommand(["install", source, "--global", "--state-dir", stateDir]);
    // Simulate data written on first use.
    const dataDir = join(stateDir, "global", "extension-data", "agent-pm");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "db"), "x");

    await runExtCommand(["install", source, "--global", "--state-dir", stateDir]);
    expect(existsSync(join(dataDir, "db"))).toBe(true);
  });
});
