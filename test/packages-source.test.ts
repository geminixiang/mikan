import { describe, expect, test } from "vitest";
import { formatSource, gitRepoPath, parseSource, sourceIdentity } from "../src/packages/index.js";

describe("parseSource", () => {
  test("github: shorthand expands to an https clone URL", () => {
    expect(parseSource("github:owner/repo")).toEqual({
      type: "git",
      url: "https://github.com/owner/repo.git",
    });
  });

  test("protocol URLs are git sources without a prefix", () => {
    expect(parseSource("https://github.com/owner/repo.git")).toEqual({
      type: "git",
      url: "https://github.com/owner/repo.git",
    });
  });

  test("git: prefix accepts host/owner/repo shorthand", () => {
    expect(parseSource("git:github.com/owner/repo")).toEqual({
      type: "git",
      url: "https://github.com/owner/repo.git",
    });
  });

  test("ref and subpath parse together", () => {
    expect(parseSource("github:owner/repo@v1.2.0#examples/agent-pm")).toEqual({
      type: "git",
      url: "https://github.com/owner/repo.git",
      ref: "v1.2.0",
      subpath: "examples/agent-pm",
    });
  });

  test("the @ in an SSH locator is authority, not a ref", () => {
    expect(parseSource("git@github.com:owner/repo.git")).toEqual({
      type: "git",
      url: "git@github.com:owner/repo.git",
    });
  });

  test("an SSH locator can still carry a ref", () => {
    expect(parseSource("git@github.com:owner/repo.git@v1")).toEqual({
      type: "git",
      url: "git@github.com:owner/repo.git",
      ref: "v1",
    });
  });

  test("credentials in the authority are not mistaken for a ref", () => {
    expect(parseSource("https://user@github.com/owner/repo")).toEqual({
      type: "git",
      url: "https://user@github.com/owner/repo",
    });
  });

  test("absolute and relative paths are local sources, resolved", () => {
    expect(parseSource("/srv/ext/agent-pm")).toEqual({
      type: "local",
      path: "/srv/ext/agent-pm",
    });
    expect(parseSource("./agent-pm").type).toBe("local");
  });

  test("a bare host/owner/repo is rejected as ambiguous with a path", () => {
    expect(() => parseSource("github.com/owner/repo")).toThrow(/Unrecognized package source/);
  });

  test("traversal in a subpath is rejected", () => {
    expect(() => parseSource("github:owner/repo#../../etc")).toThrow(/without '\.\.'/);
  });

  test("a local source cannot carry a ref or subpath", () => {
    expect(() => parseSource("/srv/ext@v1")).toThrow(/cannot carry an @ref/);
    expect(() => parseSource("/srv/ext#sub")).toThrow(/cannot carry a #subpath/);
  });

  test("empty input is rejected", () => {
    expect(() => parseSource("   ")).toThrow(/empty/);
  });
});

describe("sourceIdentity", () => {
  test("transport spelling does not change identity", () => {
    const https = sourceIdentity(parseSource("https://github.com/owner/repo.git"));
    const ssh = sourceIdentity(parseSource("git@github.com:owner/repo.git"));
    const shorthand = sourceIdentity(parseSource("github:owner/repo"));
    const sshProtocol = sourceIdentity(parseSource("ssh://git@github.com/owner/repo"));
    expect(new Set([https, ssh, shorthand, sshProtocol]).size).toBe(1);
  });

  test("host casing does not change identity", () => {
    expect(sourceIdentity(parseSource("https://GitHub.com/owner/repo"))).toBe(
      sourceIdentity(parseSource("https://github.com/owner/repo")),
    );
  });

  test("the ref is excluded so two scopes pinning differently are one package", () => {
    expect(sourceIdentity(parseSource("github:owner/repo@v1"))).toBe(
      sourceIdentity(parseSource("github:owner/repo@v2")),
    );
  });

  test("the subpath is included so one monorepo can ship several packages", () => {
    expect(sourceIdentity(parseSource("github:owner/repo#a"))).not.toBe(
      sourceIdentity(parseSource("github:owner/repo#b")),
    );
  });

  test("local identity is the resolved path", () => {
    expect(sourceIdentity(parseSource("/srv/ext/agent-pm"))).toBe("local:/srv/ext/agent-pm");
  });
});

describe("gitRepoPath", () => {
  test("drops transport, credentials, and the .git suffix", () => {
    expect(gitRepoPath("https://user:pw@github.com/owner/repo.git")).toBe("github.com/owner/repo");
    expect(gitRepoPath("git@gitlab.example.com:group/sub/repo.git")).toBe(
      "gitlab.example.com/group/sub/repo",
    );
  });

  test("segments stay filesystem-safe so the clone path cannot escape", () => {
    expect(gitRepoPath("https://github.com/owner/repo").split("/")).not.toContain("..");
    expect(gitRepoPath("file:///tmp/some repo")).not.toMatch(/\s/);
  });
});

describe("formatSource", () => {
  test("round-trips through parse", () => {
    for (const source of [
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo.git@v1",
      "https://github.com/owner/repo.git@v1#examples/ext",
      "/srv/ext/agent-pm",
    ]) {
      expect(formatSource(parseSource(source))).toBe(source);
    }
  });

  test("normalizes shorthand to the canonical clone URL", () => {
    expect(formatSource(parseSource("github:owner/repo@v1"))).toBe(
      "https://github.com/owner/repo.git@v1",
    );
  });
});
