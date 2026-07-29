import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultStateDir, resolveStateDir, takeValueFlag } from "../cli/arg-grammar.js";
import { resolveBoot, helpText } from "../cli/boot.js";

const HOME_STATE = join(homedir(), ".mikan");

describe("resolveBoot", () => {
  test("no args: run mode with all defaults", () => {
    // The suite-wide temp MIKAN_STATE_DIR (test/setup/state-dir.ts) must not
    // read as this test's ambient environment.
    const prev = process.env.MIKAN_STATE_DIR;
    delete process.env.MIKAN_STATE_DIR;
    let plan;
    try {
      plan = resolveBoot([]);
    } finally {
      if (prev !== undefined) process.env.MIKAN_STATE_DIR = prev;
    }
    expect(plan).toMatchObject({
      mode: "run",
      stateDir: HOME_STATE,
      workingDir: join(HOME_STATE, "workspace"),
      workingDirExplicit: false,
      sandbox: { type: "host" },
    });
  });

  test("positional working dir is resolved and marked explicit", () => {
    const plan = resolveBoot(["--sandbox=host", "/tmp/mikan"]);
    expect(plan.mode).toBe("run");
    expect(plan.workingDir).toBe(resolve("/tmp/mikan"));
    expect(plan.workingDirExplicit).toBe(true);
  });

  test("--flag value and --flag=value forms are equivalent", () => {
    const a = resolveBoot(["--state-dir", "/tmp/state", "--sandbox", "host"]);
    const b = resolveBoot(["--state-dir=/tmp/state", "--sandbox=host"]);
    expect(a.stateDir).toBe(resolve("/tmp/state"));
    expect(b.stateDir).toBe(a.stateDir);
    expect(a.sandbox).toEqual(b.sandbox);
  });

  test("default working dir follows an explicit state dir", () => {
    const plan = resolveBoot(["--state-dir=/tmp/state"]);
    expect(plan.workingDir).toBe(resolve("/tmp/state/workspace"));
    expect(plan.workingDirExplicit).toBe(false);
  });

  test("flag values are never taken as the positional working dir", () => {
    const plan = resolveBoot(["--sandbox", "host", "--download", "C123"]);
    expect(plan.workingDirExplicit).toBe(false);
    expect(plan.mode).toBe("download");
    expect(plan.downloadChannel).toBe("C123");
  });

  test("--sandbox parses the sandbox DSL", () => {
    expect(resolveBoot(["--sandbox=container:dev"]).sandbox).toMatchObject({
      type: "container",
      container: "dev",
    });
    expect(resolveBoot(["--sandbox=image:ghcr.io/x/y:latest"]).sandbox).toMatchObject({
      type: "image",
    });
  });

  test("a bad --sandbox spec throws (propagates to the caller)", () => {
    expect(() => resolveBoot(["--sandbox=bogus:nope"])).toThrow();
  });

  test("mode priority: help > version > onboard > download > run", () => {
    expect(resolveBoot(["--version", "--help"]).mode).toBe("help");
    expect(resolveBoot(["--onboard", "--version"]).mode).toBe("version");
    expect(resolveBoot(["--download=C1", "--onboard"]).mode).toBe("onboard");
    expect(resolveBoot(["--download=C1"]).mode).toBe("download");
  });

  test.each([["--version"], ["-v"], ["-V"]])("%s selects version mode", (flag) => {
    expect(resolveBoot([flag]).mode).toBe("version");
  });

  test.each([["--help"], ["-h"]])("%s selects help mode", (flag) => {
    expect(resolveBoot([flag]).mode).toBe("help");
  });

  test("unknown flags are an error, not silently ignored", () => {
    expect(() => resolveBoot(["--sandox=host"])).toThrow(/Unknown flag: --sandox=host/);
  });

  test("removed --worker-token flag is rejected", () => {
    expect(() => resolveBoot(["--worker-token"])).toThrow(/Unknown flag: --worker-token/);
  });

  test("ext short-circuits before flag parsing", () => {
    const plan = resolveBoot(["ext", "install", "--sandbox=not-a-real-spec"]);
    expect(plan.mode).toBe("ext");
    expect(plan.extArgs).toEqual(["install", "--sandbox=not-a-real-spec"]);
  });

  test("office subcommand short-circuits with its own argv", () => {
    const plan = resolveBoot(["office", "claim", "C123", "slack"]);
    expect(plan.mode).toBe("office");
    expect(plan.officeArgs).toEqual(["claim", "C123", "slack"]);
  });

  test("env subcommand selects env mode", () => {
    expect(resolveBoot(["env"]).mode).toBe("env");
  });
});

describe("helpText", () => {
  test("documents every flag the parser accepts", () => {
    const help = helpText();
    for (const flag of [
      "--state-dir",
      "--sandbox",
      "--onboard",
      "--download",
      "--version",
      "--help",
    ]) {
      expect(help).toContain(flag);
    }
    expect(help).not.toContain("--worker-token");
    expect(help).not.toContain("gondolin:remote");
  });
});

describe("arg-grammar", () => {
  test("defaultStateDir is ~/.mikan", () => {
    expect(defaultStateDir()).toBe(HOME_STATE);
  });

  test("takeValueFlag handles both spellings and consumption width", () => {
    expect(takeValueFlag(["--x", "v"], 0, "--x")).toEqual({ value: "v", lastIndex: 1 });
    expect(takeValueFlag(["--x=v"], 0, "--x")).toEqual({ value: "v", lastIndex: 0 });
    expect(takeValueFlag(["--y=v"], 0, "--x")).toBeUndefined();
    expect(takeValueFlag(["--x"], 0, "--x")).toEqual({ value: "", lastIndex: 1 });
  });

  test("resolveStateDir matches the full parser's answer", () => {
    for (const args of [
      ["--state-dir", "/tmp/state", "/tmp/mikan"],
      ["--state-dir=/tmp/state", "/tmp/mikan"],
      ["/tmp/mikan"],
      [],
    ]) {
      expect(resolveStateDir(args)).toBe(resolveBoot(args).stateDir);
    }
  });

  test("state-dir precedence: flag > env > default", () => {
    const prev = process.env.MIKAN_STATE_DIR;
    delete process.env.MIKAN_STATE_DIR;
    try {
      expect(resolveStateDir(["--state-dir=/tmp/flag"], "/tmp/env")).toBe(resolve("/tmp/flag"));
      expect(resolveStateDir([], "/tmp/env")).toBe(resolve("/tmp/env"));
      expect(resolveStateDir([], undefined)).toBe(defaultStateDir());
    } finally {
      if (prev !== undefined) process.env.MIKAN_STATE_DIR = prev;
    }
  });

  test("last --state-dir flag wins, matching the historical parsers", () => {
    expect(resolveStateDir(["--state-dir=/tmp/a", "--state-dir=/tmp/b"], undefined)).toBe(
      resolve("/tmp/b"),
    );
  });

  test("boot plan honors STATE_DIR env when no flag is given", () => {
    const prev = { state: process.env.STATE_DIR, mikan: process.env.MIKAN_STATE_DIR };
    process.env.STATE_DIR = "/tmp/env-state";
    delete process.env.MIKAN_STATE_DIR;
    try {
      expect(resolveBoot([]).stateDir).toBe(resolve("/tmp/env-state"));
      expect(resolveBoot(["--state-dir=/tmp/flag-state"]).stateDir).toBe(
        resolve("/tmp/flag-state"),
      );
    } finally {
      if (prev.state === undefined) delete process.env.STATE_DIR;
      else process.env.STATE_DIR = prev.state;
      if (prev.mikan !== undefined) process.env.MIKAN_STATE_DIR = prev.mikan;
    }
  });
});
