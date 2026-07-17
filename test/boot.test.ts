import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { defaultStateDir, resolveStateDirFromArgv, takeValueFlag } from "../src/cli/arg-grammar.js";
import { resolveBoot, helpText } from "../src/cli/boot.js";

const HOME_STATE = join(homedir(), ".mikan");

describe("resolveBoot", () => {
  test("no args: run mode with all defaults", () => {
    const plan = resolveBoot([]);
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

  test("mode priority: help > version > worker-token > onboard > download > run", () => {
    expect(resolveBoot(["--version", "--help"]).mode).toBe("help");
    expect(resolveBoot(["--onboard", "--version"]).mode).toBe("version");
    expect(resolveBoot(["--onboard", "--worker-token"]).mode).toBe("worker-token");
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

  test("ext short-circuits before flag parsing", () => {
    const plan = resolveBoot(["ext", "install", "--sandbox=not-a-real-spec"]);
    expect(plan.mode).toBe("ext");
    expect(plan.extArgs).toEqual(["install", "--sandbox=not-a-real-spec"]);
  });
});

describe("helpText", () => {
  test("documents every flag the parser accepts", () => {
    const help = helpText();
    for (const flag of [
      "--state-dir",
      "--sandbox",
      "--onboard",
      "--worker-token",
      "--download",
      "--version",
      "--help",
    ]) {
      expect(help).toContain(flag);
    }
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

  test("resolveStateDirFromArgv matches the full parser's answer", () => {
    for (const args of [
      ["--state-dir", "/tmp/state", "/tmp/mikan"],
      ["--state-dir=/tmp/state", "/tmp/mikan"],
      ["/tmp/mikan"],
      [],
    ]) {
      expect(resolveStateDirFromArgv(args)).toBe(resolveBoot(args).stateDir);
    }
  });
});
