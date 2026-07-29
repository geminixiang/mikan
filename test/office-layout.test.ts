import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createOfficeAddress,
  createWorkspace,
  officeKey,
  RESERVED_WORKSPACE_NAMES,
} from "../src/office/index.js";

const temporaryDirectories: string[] = [];

function makeFixture(): { root: string; stateDir: string; workspaceRoot: string } {
  const root = join(tmpdir(), `mikan-office-layout-${Date.now()}-${Math.random()}`);
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  temporaryDirectories.push(root);
  return { root, stateDir, workspaceRoot };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createWorkspace", () => {
  test("exposes the workspace-global layout from the root", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });

    expect(workspace.root).toBe(fixture.workspaceRoot);
    expect(workspace.stateDir).toBe(fixture.stateDir);
    expect(workspace.memoryPath).toBe(join(fixture.workspaceRoot, "MEMORY.md"));
    expect(workspace.skillsDir).toBe(join(fixture.workspaceRoot, "skills"));
    expect(workspace.eventsDir).toBe(join(fixture.workspaceRoot, "events"));
    expect(workspace.agentsDir).toBe(join(fixture.workspaceRoot, "agents"));
    expect(workspace.reservedNames).toBe(RESERVED_WORKSPACE_NAMES);
  });

  test("reserved names cover every workspace-global surface", () => {
    expect([...RESERVED_WORKSPACE_NAMES].toSorted()).toEqual([
      "MEMORY.md",
      "agents",
      "events",
      "skills",
    ]);
  });

  test("the workspace value is frozen", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    expect(Object.isFrozen(workspace)).toBe(true);
  });
});

describe("workspace.office", () => {
  test("derives the whole office layout from the address", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const address = createOfficeAddress("slack", "C0A34FL8PMH");
    const office = workspace.office(address);
    const key = officeKey(address);
    const dir = join(fixture.workspaceRoot, key);

    expect(office.address).toEqual(address);
    expect(office.key).toBe(key);
    expect(office.dir).toBe(dir);
    expect(office.memoryPath).toBe(join(dir, "MEMORY.md"));
    expect(office.skillsDir).toBe(join(dir, "skills"));
    expect(office.sessionsDir).toBe(join(dir, "sessions"));
    expect(office.attachmentsDir).toBe(join(dir, "attachments"));
    expect(office.logPath).toBe(join(dir, "log.jsonl"));
    expect(office.stateDir).toBe(join(fixture.stateDir, "conversations", key));
    expect(office.workspace).toBe(workspace);
    expect(Object.isFrozen(office)).toBe(true);
  });

  test("memoizes: the same address yields the same value", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const first = workspace.office(createOfficeAddress("slack", "C1"));
    const second = workspace.office(createOfficeAddress("slack", "C1"));
    expect(second).toBe(first);
  });

  test("two platforms sharing a raw id never share an office", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const discord = workspace.office(createOfficeAddress("discord", "12345"));
    const telegram = workspace.office(createOfficeAddress("telegram", "12345"));
    expect(discord.dir).not.toBe(telegram.dir);
    expect(discord.stateDir).not.toBe(telegram.stateDir);
  });

  test("rejects an invalid address", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    expect(() => workspace.office({ platform: "slack", conversationId: "a/b" })).toThrow(
      /path separators/,
    );
  });
});

describe("office.ensure", () => {
  test("records the office in the registry, then creates the directory", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C77"));

    const dir = office.ensure();

    expect(dir).toBe(office.dir);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    const registry = JSON.parse(
      readFileSync(join(fixture.stateDir, "office-registry.json"), "utf-8"),
    ) as { offices: Array<{ platform: string; conversationId: string }> };
    expect(registry.offices).toEqual([
      expect.objectContaining({ platform: "slack", conversationId: "C77" }),
    ]);
  });

  test("is idempotent and cheap after the first sighting", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const office = workspace.office(createOfficeAddress("telegram", "-100200"));

    const first = office.ensure();
    const second = office.ensure();
    expect(second).toBe(first);
    const registry = JSON.parse(
      readFileSync(join(fixture.stateDir, "office-registry.json"), "utf-8"),
    ) as { offices: unknown[] };
    expect(registry.offices).toHaveLength(1);
  });

  test("recreates the directory when it disappears after the record was cached", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C99"));

    office.ensure();
    rmSync(office.dir, { recursive: true, force: true });
    expect(existsSync(office.dir)).toBe(false);

    expect(office.ensure()).toBe(office.dir);
    expect(lstatSync(office.dir).isDirectory()).toBe(true);
  });

  test("fails closed when the office path is a symlink", () => {
    const fixture = makeFixture();
    const workspace = createWorkspace({ root: fixture.workspaceRoot, stateDir: fixture.stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C55"));
    symlinkSync(fixture.root, office.dir);

    expect(() => office.ensure()).toThrow(/regular non-symlink directory/);
  });
});
