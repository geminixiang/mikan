import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { stateDirPath } from "../cli/arg-grammar.js";
import { resolveBoot, helpText } from "../cli/boot.js";

const HOME_STATE = join(homedir(), ".mikan");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBoot", () => {
  test("no args: run mode with all defaults", () => {
    expect(resolveBoot([])).toMatchObject({
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
    const a = resolveBoot(["--sandbox", "container:dev"]);
    const b = resolveBoot(["--sandbox=container:dev"]);
    expect(a.sandbox).toEqual(b.sandbox);
  });

  test("the state dir is always ~/.mikan, whatever STATE_DIR says", () => {
    vi.stubEnv("STATE_DIR", "/tmp/env-state");
    vi.stubEnv("MIKAN_STATE_DIR", "/tmp/env-state");
    expect(resolveBoot([]).stateDir).toBe(HOME_STATE);
    expect(resolveBoot(["onboard"]).stateDir).toBe(HOME_STATE);
    expect(stateDirPath()).toBe(HOME_STATE);
  });

  test.each([[["--state-dir", "/tmp/state"]], [["onboard", "--state-dir=/tmp/state"]]])(
    "--state-dir is an unknown option: %j",
    (args) => {
      expect(() => resolveBoot(args)).toThrow(/unknown option '--state-dir/);
    },
  );

  test("flag values are never taken as the positional working dir", () => {
    const plan = resolveBoot(["--sandbox", "host"]);
    expect(plan.workingDirExplicit).toBe(false);
    expect(plan.mode).toBe("run");
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

  test("mode priority: help > version > onboard > run", () => {
    expect(resolveBoot(["--version", "--help"]).mode).toBe("help");
    expect(resolveBoot(["--onboard", "--version"]).mode).toBe("version");
    expect(resolveBoot(["--onboard"]).mode).toBe("onboard");
  });

  test("`onboard` subcommand selects onboard mode, but only in first position", () => {
    expect(resolveBoot(["onboard"]).mode).toBe("onboard");
    expect(resolveBoot(["/some/dir", "onboard"]).mode).toBe("run");
  });

  test.each([["--version"], ["-v"], ["-V"]])("%s selects version mode", (flag) => {
    expect(resolveBoot([flag]).mode).toBe("version");
  });

  test.each([["--help"], ["-h"]])("%s selects help mode", (flag) => {
    expect(resolveBoot([flag]).mode).toBe("help");
  });

  test("unknown flags are an error, not silently ignored", () => {
    expect(() => resolveBoot(["--sandox=host"])).toThrow(/unknown option '--sandox=host'/);
  });

  test("removed --worker-token flag is rejected", () => {
    expect(() => resolveBoot(["--worker-token"])).toThrow(/unknown option '--worker-token'/);
  });

  test("migrate subcommand short-circuits with its own argv", () => {
    const plan = resolveBoot(["migrate", "--dry-run", "--owner", "C123=slack"]);
    expect(plan.mode).toBe("migrate");
    expect(plan.migrateArgs).toEqual(["--dry-run", "--owner", "C123=slack"]);
  });

  test("env subcommand selects env mode", () => {
    expect(resolveBoot(["env"]).mode).toBe("env");
  });
});

describe("helpText", () => {
  test("documents every flag the parser accepts", () => {
    const help = helpText();
    for (const flag of ["--sandbox", "mikan onboard", "--version", "--help"]) {
      expect(help).toContain(flag);
    }
    expect(help).not.toContain("--worker-token");
    expect(help).not.toContain("--state-dir");
  });
});

describe("arg-grammar", () => {
  test("--download is an unknown option", () => {
    expect(() => resolveBoot(["--download", "C0123456789"])).toThrow(/unknown option '--download'/);
  });

  test.each([["--sandbox"]])("rejects missing option values: %j", (...args) => {
    expect(() => resolveBoot(args)).toThrow();
  });
});
