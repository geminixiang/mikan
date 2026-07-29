import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runOfficeCommand } from "../cli/office.js";
import { createOfficeAddress } from "../office/index.js";
import { OfficeRegistry } from "../office/index.js";

let root: string;
let stateDir: string;
let workspaceRoot: string;

beforeEach(() => {
  root = join(tmpdir(), `mikan-office-cli-${Date.now()}-${Math.random()}`);
  stateDir = join(root, "state");
  workspaceRoot = join(root, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("mikan office", () => {
  test("claim records the owner for the daemon's next boot", () => {
    mkdirSync(join(workspaceRoot, "900100"), { recursive: true });
    const registry = new OfficeRegistry(stateDir);
    registry.enablePlatform("telegram");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runOfficeCommand([
      "claim",
      "900100",
      "telegram",
      "--state-dir",
      stateDir,
      "--workspace",
      workspaceRoot,
    ]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Claimed 900100 for telegram"));
    expect(new OfficeRegistry(stateDir).getMigration("900100")).toMatchObject({
      status: "prepared",
      ownerPlatform: "telegram",
    });
  });

  test("claim refuses a platform that is not enabled", () => {
    mkdirSync(join(workspaceRoot, "900100"), { recursive: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runOfficeCommand([
      "claim",
      "900100",
      "discord",
      "--state-dir",
      stateDir,
      "--workspace",
      workspaceRoot,
    ]);

    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not enabled"));
  });

  test("list prints offices and pending migrations", () => {
    const registry = new OfficeRegistry(stateDir);
    registry.recordOffice(createOfficeAddress("slack", "C123"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = runOfficeCommand(["list", "--state-dir", stateDir]);

    expect(code).toBe(0);
    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Offices (1):");
    expect(output).toContain("slack  C123");
  });

  test("unknown action prints usage and fails", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runOfficeCommand(["frobnicate", "--state-dir", stateDir])).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });
});
