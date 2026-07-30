import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runExtCommand } from "../cli/ext.js";
import { createOfficeAddress, officeKey } from "../office/index.js";
import { OfficeRegistry } from "../office/index.js";

let stateDir: string;
let srcDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-ext-cli-state-"));
  srcDir = mkdtempSync(join(tmpdir(), "mikan-ext-cli-src-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeExtension(name: string): string {
  const dir = join(srcDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.mjs"), "export default function activate() {}");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name, version: "0.1.0" }));
  return dir;
}

function captureOut(): { log: string[]; err: string[]; restore: () => void } {
  const log: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => void log.push(a.join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a) => void err.push(a.join(" ")));
  return { log, err, restore: () => (logSpy.mockRestore(), errSpy.mockRestore()) };
}

describe("mikan ext CLI", () => {
  // The CLI resolves raw conversation ids through the office registry.
  beforeEach(() => {
    const registry = new OfficeRegistry(stateDir);
    registry.recordOffice(createOfficeAddress("slack", "D0AKS5AHX89"));
    registry.recordOffice(createOfficeAddress("slack", "C1"));
  });

  test("install places code under the conversation scope and reports data path", async () => {
    const source = writeExtension("agent-pm");
    const out = captureOut();
    const code = await runExtCommand([
      "install",
      source,
      "--conversation",
      "D0AKS5AHX89",
      "--state-dir",
      stateDir,
    ]);
    out.restore();

    expect(code).toBe(0);
    expect(
      existsSync(
        join(
          stateDir,
          "conversations",
          officeKey(createOfficeAddress("slack", "D0AKS5AHX89")),
          "extensions",
          "agent-pm",
          "index.mjs",
        ),
      ),
    ).toBe(true);
    expect(out.log.join("\n")).toMatch(/slug: agent-pm/);
    expect(out.log.join("\n")).toMatch(/extension-data[/\\]agent-pm/);
  });

  test("install into global scope", async () => {
    const source = writeExtension("audit");
    const out = captureOut();
    const code = await runExtCommand(["install", source, "--global", "--state-dir", stateDir]);
    out.restore();
    expect(code).toBe(0);
    expect(existsSync(join(stateDir, "global", "extensions", "audit", "index.mjs"))).toBe(true);
  });

  test("install refuses an invalid extension", async () => {
    const dir = join(srcDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.mjs"), "export const nope = 1;");
    const out = captureOut();
    const code = await runExtCommand(["install", dir, "--global", "--state-dir", stateDir]);
    out.restore();
    expect(code).toBe(1);
    expect(existsSync(join(stateDir, "global", "extensions", "broken"))).toBe(false);
  });

  test("install requires a scope", async () => {
    const source = writeExtension("agent-pm");
    const out = captureOut();
    const code = await runExtCommand(["install", source, "--state-dir", stateDir]);
    out.restore();
    expect(code).toBe(1);
    expect(out.err.join(" ")).toMatch(/--global or --conversation/);
  });

  test("list shows installed global extensions", async () => {
    await runExtCommand(["install", writeExtension("audit"), "--global", "--state-dir", stateDir]);
    const out = captureOut();
    const code = await runExtCommand(["list", "--state-dir", stateDir]);
    out.restore();
    expect(code).toBe(0);
    expect(out.log.join("\n")).toMatch(/audit@0\.1\.0.*global.*slug=audit/s);
  });

  test("remove deletes code and leaves data", async () => {
    const source = writeExtension("agent-pm");
    await runExtCommand(["install", source, "--conversation", "C1", "--state-dir", stateDir]);
    const codeDir = join(
      stateDir,
      "conversations",
      officeKey(createOfficeAddress("slack", "C1")),
      "extensions",
      "agent-pm",
    );
    // Simulate data written on first use.
    const dataDir = join(
      stateDir,
      "conversations",
      officeKey(createOfficeAddress("slack", "C1")),
      "extension-data",
      "agent-pm",
    );
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "db"), "x");

    const out = captureOut();
    const code = await runExtCommand([
      "remove",
      "agent-pm",
      "--conversation",
      "C1",
      "--state-dir",
      stateDir,
    ]);
    out.restore();

    expect(code).toBe(0);
    expect(existsSync(codeDir)).toBe(false);
    expect(existsSync(join(dataDir, "db"))).toBe(true);
  });

  test("unknown action prints usage and fails", async () => {
    const out = captureOut();
    const code = await runExtCommand(["frobnicate"]);
    out.restore();
    expect(code).toBe(1);
    expect(out.err.join("\n")).toMatch(/Usage:/);
  });
});
