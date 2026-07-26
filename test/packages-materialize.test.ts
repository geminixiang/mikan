import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gitCloneDir, materializeSource, packageScopeDir } from "../src/packages/index.js";

function run(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" },
  });
}

describe("materializeSource", () => {
  let repo: string;
  let stateDir: string;
  let source: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mikan-pkg-repo-"));
    stateDir = mkdtempSync(join(tmpdir(), "mikan-pkg-state-"));
    source = `file://${repo}`;

    const extDir = join(repo, "extensions", "agent-pm");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.mjs"), "export default function activate() {}");
    writeFileSync(join(repo, "marker"), "v1");
    run(repo, ["init", "-q"]);
    run(repo, ["add", "-A"]);
    run(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"]);
    run(repo, ["tag", "v1"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("clones into the global scope's git dir", () => {
    const result = materializeSource(source, { scope: "global", stateDir });
    expect(result.dir).toBe(gitCloneDir(source, join(stateDir, "global")));
    expect(result.dir.startsWith(join(stateDir, "global", "git"))).toBe(true);
    expect(readFileSync(join(result.dir, "marker"), "utf-8")).toBe("v1");
  });

  test("clones into the conversation scope's git dir", () => {
    const result = materializeSource(source, {
      scope: "conversation",
      conversationId: "C03045VJJAY",
      stateDir,
    });
    expect(result.dir.startsWith(join(stateDir, "conversations", "C03045VJJAY", "git"))).toBe(true);
  });

  test("checkout keys share a ref across subpaths and isolate other refs", () => {
    const scopeDir = join(stateDir, "global");
    expect(gitCloneDir(source, scopeDir, "v1")).toBe(gitCloneDir(source, scopeDir, "v1"));
    expect(gitCloneDir(source, scopeDir, "v1")).not.toBe(gitCloneDir(source, scopeDir, "v2"));
    expect(gitCloneDir(source, scopeDir)).toBe(gitCloneDir(source, scopeDir, "HEAD"));
  });

  test("a #subpath resolves to the directory inside the clone", () => {
    const result = materializeSource(`${source}#extensions/agent-pm`, {
      scope: "global",
      stateDir,
    });
    expect(existsSync(join(result.dir, "index.mjs"))).toBe(true);
  });

  test("a missing subpath reports the subpath, not a git error", () => {
    expect(() =>
      materializeSource(`${source}#nope/missing`, { scope: "global", stateDir }),
    ).toThrow(/Subpath not found in repository: nope\/missing/);
  });

  test("an unknown ref reports the ref and the remote", () => {
    expect(() => materializeSource(`${source}@v99`, { scope: "global", stateDir })).toThrow(
      /Could not fetch .* at v99/,
    );
  });

  test("a failed first clone leaves no half-materialized directory behind", () => {
    const dir = gitCloneDir(source, join(stateDir, "global"), "v99");
    expect(() => materializeSource(`${source}@v99`, { scope: "global", stateDir })).toThrow();
    expect(existsSync(dir)).toBe(false);
  });

  test("a failed dependency install is retried before the ref marker is written", () => {
    const packageJson = join(repo, "package.json");
    writeFileSync(packageJson, JSON.stringify({ dependencies: { "missing-package": "1.0.0" } }));
    run(repo, ["add", "package.json"]);
    run(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "deps"]);

    const npmDir = join(stateDir, "fake-bin");
    const callsFile = join(stateDir, "npm-calls");
    mkdirSync(npmDir, { recursive: true });
    const fakeNpm = join(npmDir, "npm");
    writeFileSync(
      fakeNpm,
      `#!/bin/sh\ncalls=$(cat "${callsFile}" 2>/dev/null || echo 0)\ncalls=$((calls + 1))\necho "$calls" > "${callsFile}"\n[ "$calls" -ne 1 ]\n`,
    );
    chmodSync(fakeNpm, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${npmDir}:${originalPath ?? ""}`;
    try {
      expect(() => materializeSource(source, { scope: "global", stateDir })).toThrow(
        /npm install failed/,
      );
      const clone = gitCloneDir(source, join(stateDir, "global"));
      expect(existsSync(join(clone, ".git", "mikan-ref"))).toBe(false);

      expect(materializeSource(source, { scope: "global", stateDir }).dir).toBe(clone);
      expect(readFileSync(callsFile, "utf-8").trim()).toBe("2");
      expect(readFileSync(join(clone, ".git", "mikan-ref"), "utf-8").trim()).toBe("HEAD");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("re-materializing without refresh does not move the checkout", () => {
    materializeSource(source, { scope: "global", stateDir });
    writeFileSync(join(repo, "marker"), "v2");
    run(repo, ["add", "-A"]);
    run(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"]);

    const again = materializeSource(source, { scope: "global", stateDir });
    expect(readFileSync(join(again.dir, "marker"), "utf-8")).toBe("v1");
  });

  test("refresh advances an unpinned package to the new default-branch head", () => {
    materializeSource(source, { scope: "global", stateDir });
    writeFileSync(join(repo, "marker"), "v2");
    run(repo, ["add", "-A"]);
    run(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"]);

    const refreshed = materializeSource(source, { scope: "global", stateDir, mode: "refresh" });
    expect(readFileSync(join(refreshed.dir, "marker"), "utf-8")).toBe("v2");
  });

  test("refresh leaves a pinned tag where it is", () => {
    const pinned = `${source}@v1`;
    materializeSource(pinned, { scope: "global", stateDir });
    writeFileSync(join(repo, "marker"), "v2");
    run(repo, ["add", "-A"]);
    run(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"]);

    const refreshed = materializeSource(pinned, { scope: "global", stateDir, mode: "refresh" });
    expect(readFileSync(join(refreshed.dir, "marker"), "utf-8")).toBe("v1");
  });

  test("refresh discards edits made to the clone", () => {
    const first = materializeSource(source, { scope: "global", stateDir });
    writeFileSync(join(first.dir, "marker"), "tampered");
    const refreshed = materializeSource(source, { scope: "global", stateDir, mode: "refresh" });
    expect(readFileSync(join(refreshed.dir, "marker"), "utf-8")).toBe("v1");
  });

  test("a local source is used by reference, not copied", () => {
    const result = materializeSource(repo, { scope: "global", stateDir });
    expect(result.dir).toBe(repo);
    expect(existsSync(join(stateDir, "global", "git"))).toBe(false);
  });

  test("a local source that does not exist reports the path", () => {
    expect(() => materializeSource("/nope/not/here", { scope: "global", stateDir })).toThrow(
      /Path does not exist on the mikan host/,
    );
  });

  test("offline mode refuses to clone a package that is not on disk yet", () => {
    expect(() => materializeSource(source, { scope: "global", stateDir, mode: "offline" })).toThrow(
      /Not fetched on this host yet/,
    );
    expect(existsSync(gitCloneDir(source, join(stateDir, "global")))).toBe(false);
  });

  test("offline mode uses an existing clone without reaching the remote", () => {
    materializeSource(source, { scope: "global", stateDir });
    rmSync(repo, { recursive: true, force: true });
    const offline = materializeSource(source, { scope: "global", stateDir, mode: "offline" });
    expect(readFileSync(join(offline.dir, "marker"), "utf-8")).toBe("v1");
  });
});

describe("packageScopeDir", () => {
  test("global and conversation scopes are siblings under the state dir", () => {
    expect(packageScopeDir("global", undefined, "/s")).toBe("/s/global");
    expect(packageScopeDir("conversation", "C1", "/s")).toBe("/s/conversations/C1");
  });

  test("a conversation scope needs an id", () => {
    expect(() => packageScopeDir("conversation", undefined, "/s")).toThrow(/conversation id/);
  });

  test("a conversation id that is not a safe path segment is rejected", () => {
    expect(() => packageScopeDir("conversation", "../escape", "/s")).toThrow(/safe path segment/);
  });
});
