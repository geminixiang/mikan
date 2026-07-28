import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createOfficeAddress, officeDir } from "../src/office-address.js";
import { migrateLegacyOffices, formatUnmigratedOfficesError } from "../src/office-migration.js";
import { OfficeRegistry } from "../src/office-registry.js";

const temporaryDirectories: string[] = [];

function makeFixture(): { stateDir: string; workspaceRoot: string } {
  const root = join(tmpdir(), `mikan-office-migration-${Date.now()}-${Math.random()}`);
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  temporaryDirectories.push(root);
  return { stateDir, workspaceRoot };
}

function makeLegacyOffice(workspaceRoot: string, rawId: string): string {
  const dir = join(workspaceRoot, rawId);
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "log.jsonl"), `{"ts":"1"}\n`);
  return dir;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrateLegacyOffices", () => {
  test("an empty workspace migrates nothing and records enabled platforms", () => {
    const { stateDir, workspaceRoot } = makeFixture();

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary).toEqual({ migrated: [], recovered: [], unowned: [], failed: [] });
    expect(new OfficeRegistry(stateDir).getState().enabledPlatforms).toEqual(["slack"]);
  });

  test("a single enabled platform claims and moves legacy dirs, preserving content", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    makeLegacyOffice(workspaceRoot, "D900");
    mkdirSync(join(workspaceRoot, "skills"));
    mkdirSync(join(workspaceRoot, "events"));
    writeFileSync(join(workspaceRoot, "MEMORY.md"), "shared");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.migrated).toEqual(["C123", "D900"]);
    const target = officeDir(workspaceRoot, createOfficeAddress("slack", "C123"));
    expect(existsSync(join(workspaceRoot, "C123"))).toBe(false);
    expect(readFileSync(join(target, "log.jsonl"), "utf-8")).toContain('"ts":"1"');
    expect(existsSync(join(workspaceRoot, "skills"))).toBe(true);
    expect(existsSync(join(workspaceRoot, "MEMORY.md"))).toBe(true);

    const registry = new OfficeRegistry(stateDir);
    expect(registry.getMigration("C123")?.status).toBe("committed");
    expect(registry.getOffices()).toContainEqual(
      expect.objectContaining({ platform: "slack", conversationId: "C123" }),
    );
  });

  test("a second run after migration is a no-op", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    migrateLegacyOffices({ workspaceRoot, stateDir, enabledPlatforms: ["slack"] });

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary).toEqual({ migrated: [], recovered: [], unowned: [], failed: [] });
  });

  test("multiple enabled platforms leave unowned dirs in place and report them", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "900100");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["discord", "telegram"],
    });

    expect(summary.unowned).toEqual(["900100"]);
    expect(existsSync(join(workspaceRoot, "900100"))).toBe(true);
    expect(formatUnmigratedOfficesError(summary)).toContain("mikan office claim");
  });

  test("a claimed owner from a previous run resolves ambiguity", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "900100");
    const registry = new OfficeRegistry(stateDir);
    registry.enablePlatform("discord");
    registry.enablePlatform("telegram");
    registry.prepareLegacyMigration({
      rawConversationId: "900100",
      sourceDir: join(workspaceRoot, "900100"),
      workspaceRoot,
      ownerPlatform: "telegram",
    });

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["discord", "telegram"],
    });

    expect(summary.migrated).toEqual(["900100"]);
    expect(existsSync(officeDir(workspaceRoot, createOfficeAddress("telegram", "900100")))).toBe(
      true,
    );
  });

  test("recovers a move interrupted after the journal entry but before the rename", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    const registry = new OfficeRegistry(stateDir);
    registry.enablePlatform("slack");
    registry.prepareLegacyMigration({
      rawConversationId: "C123",
      sourceDir: join(workspaceRoot, "C123"),
      workspaceRoot,
    });
    registry.markMoving("C123");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.recovered).toEqual(["C123"]);
    expect(new OfficeRegistry(stateDir).getMigration("C123")?.status).toBe("committed");
    expect(existsSync(officeDir(workspaceRoot, createOfficeAddress("slack", "C123")))).toBe(true);
  });

  test("recovers a move interrupted after the rename but before the commit", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    const registry = new OfficeRegistry(stateDir);
    registry.enablePlatform("slack");
    const prepared = registry.prepareLegacyMigration({
      rawConversationId: "C123",
      sourceDir: join(workspaceRoot, "C123"),
      workspaceRoot,
    });
    registry.markMoving("C123");
    renameSync(prepared.sourceDir, prepared.targetDir!);

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.recovered).toEqual(["C123"]);
    expect(new OfficeRegistry(stateDir).getMigration("C123")?.status).toBe("committed");
  });

  test("an ambiguous interrupted move (both dirs exist) fails the record for repair", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    const registry = new OfficeRegistry(stateDir);
    registry.enablePlatform("slack");
    const prepared = registry.prepareLegacyMigration({
      rawConversationId: "C123",
      sourceDir: join(workspaceRoot, "C123"),
      workspaceRoot,
    });
    registry.markMoving("C123");
    mkdirSync(prepared.targetDir!, { recursive: true });

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.failed).toEqual(["C123"]);
    expect(formatUnmigratedOfficesError(summary)).toContain("manual repair");
  });

  test("a legacy dir reappearing after its migration committed refuses to continue", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    migrateLegacyOffices({ workspaceRoot, stateDir, enabledPlatforms: ["slack"] });
    makeLegacyOffice(workspaceRoot, "C123");

    expect(() =>
      migrateLegacyOffices({ workspaceRoot, stateDir, enabledPlatforms: ["slack"] }),
    ).toThrow(/reappeared after migration/);
  });

  test("a symlink in office position refuses to migrate", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    symlinkSync(tmpdir(), join(workspaceRoot, "C123"));

    expect(() =>
      migrateLegacyOffices({ workspaceRoot, stateDir, enabledPlatforms: ["slack"] }),
    ).toThrow(/must not be a symlink/);
  });

  test("already office-key-shaped directories are left alone", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    const canonical = officeDir(workspaceRoot, createOfficeAddress("slack", "C123"));
    mkdirSync(canonical, { recursive: true });

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.migrated).toEqual([]);
    expect(existsSync(canonical)).toBe(true);
  });
});
