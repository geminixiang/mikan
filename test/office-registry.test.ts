import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createOfficeAddress, officeDir } from "../src/office-address.js";
import { OfficeRegistry } from "../src/office-registry.js";

const temporaryDirectories: string[] = [];

function throwRegistryWriteFailure(): never {
  throw new Error("injected registry write failure");
}

function makeFixture(): {
  root: string;
  stateDir: string;
  workspaceRoot: string;
  sourceDir: string;
  rawConversationId: string;
} {
  const root = join(tmpdir(), `mikan-office-registry-${Date.now()}-${Math.random()}`);
  const stateDir = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  const sourceDir = join(workspaceRoot, "C123");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  temporaryDirectories.push(root);
  return { root, stateDir, workspaceRoot, sourceDir, rawConversationId: "C123" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OfficeRegistry", () => {
  test("does not reclaim an old lock while its owner process is alive", () => {
    const fixture = makeFixture();
    const lockDir = join(fixture.stateDir, ".office-registry.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner"), `${process.pid}:active\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockDir, old, old);

    expect(() =>
      new OfficeRegistry(fixture.stateDir, { lockTimeoutMs: 50 }).enablePlatform("slack"),
    ).toThrow(/Timed out acquiring office registry lock/);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("a single enabled platform claims an unowned legacy directory", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");

    const record = registry.prepareLegacyMigration(fixture);

    expect(record).toMatchObject({
      rawConversationId: "C123",
      sourceDir: fixture.sourceDir,
      ownerPlatform: "slack",
      targetDir: officeDir(fixture.workspaceRoot, createOfficeAddress("slack", "C123")),
      status: "prepared",
    });
    expect(existsSync(record.targetDir!)).toBe(false);
  });

  test("multiple enabled platforms leave an unowned directory ambiguous", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    registry.enablePlatform("discord");

    const record = registry.prepareLegacyMigration(fixture);

    expect(record.status).toBe("needs-owner");
    expect(record.ownerPlatform).toBeUndefined();
    expect(record.targetDir).toBeUndefined();
    expect(() => registry.markMoving("C123")).toThrow(/needs an owner/);
  });

  test("an explicit owner resolves ambiguity without guessing from the raw id", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    registry.enablePlatform("discord");

    const record = registry.prepareLegacyMigration({ ...fixture, ownerPlatform: "discord" });

    expect(record.ownerPlatform).toBe("discord");
    expect(record.status).toBe("prepared");
  });

  test("target collisions fail closed and persist a failed state", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    const targetDir = officeDir(fixture.workspaceRoot, createOfficeAddress("slack", "C123"));
    mkdirSync(targetDir, { recursive: true });

    expect(() => registry.prepareLegacyMigration(fixture)).toThrow(/already exists/);
    expect(registry.getMigration("C123")).toMatchObject({ status: "failed", targetDir });
    expect(new OfficeRegistry(fixture.stateDir).getMigration("C123")).toMatchObject({
      status: "failed",
    });
  });

  test("symlink legacy sources are rejected", () => {
    const fixture = makeFixture();
    rmSync(fixture.sourceDir, { recursive: true });
    const outside = join(fixture.root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, fixture.sourceDir, "dir");
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");

    expect(() => registry.prepareLegacyMigration(fixture)).toThrow(/regular directory/);
    expect(registry.getMigration("C123")).toBeUndefined();
  });

  test("reloads an atomic journal and makes transitions idempotent", () => {
    const fixture = makeFixture();
    const first = new OfficeRegistry(fixture.stateDir);
    first.enablePlatform("slack");
    const prepared = first.prepareLegacyMigration(fixture);

    const reloaded = new OfficeRegistry(fixture.stateDir);
    expect(reloaded.getMigration("C123")).toEqual(prepared);
    const moving = reloaded.markMoving("C123");
    expect(reloaded.markMoving("C123")).toEqual(moving);

    rmSync(fixture.sourceDir, { recursive: true });
    mkdirSync(moving.targetDir!);
    const afterCrashReload = new OfficeRegistry(fixture.stateDir);
    const committed = afterCrashReload.markCommitted("C123");
    expect(new OfficeRegistry(fixture.stateDir).markCommitted("C123")).toEqual(committed);
    expect(committed.status).toBe("committed");

    const persisted = JSON.parse(
      readFileSync(join(fixture.stateDir, "office-registry.json"), "utf-8"),
    ) as { version: number; migrations: Array<{ status: string }> };
    expect(persisted.version).toBe(1);
    expect(persisted.migrations[0].status).toBe("committed");
  });

  test("failed transitions survive reload and cannot reopen a migration", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    registry.prepareLegacyMigration(fixture);

    const failed = registry.markFailed("C123", "operator stopped migration");
    expect(failed.status).toBe("failed");
    expect(new OfficeRegistry(fixture.stateDir).markFailed("C123", "different reason")).toEqual(
      failed,
    );
    expect(new OfficeRegistry(fixture.stateDir).markMoving("C123")).toEqual(failed);
  });

  test("rejects non-directory legacy sources", () => {
    const fixture = makeFixture();
    rmSync(fixture.sourceDir, { recursive: true });
    writeFileSync(fixture.sourceDir, "not a directory");
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");

    expect(() => registry.prepareLegacyMigration(fixture)).toThrow(/regular directory/);
  });

  test("serializes registry instances without losing platform or migration updates", () => {
    const fixture = makeFixture();
    const secondSourceDir = join(fixture.workspaceRoot, "D456");
    mkdirSync(secondSourceDir);
    const secondFixture = { ...fixture, sourceDir: secondSourceDir, rawConversationId: "D456" };
    const first = new OfficeRegistry(fixture.stateDir);
    const second = new OfficeRegistry(fixture.stateDir);

    first.enablePlatform("slack");
    second.enablePlatform("discord");
    first.prepareLegacyMigration(fixture);
    second.prepareLegacyMigration({ ...secondFixture, ownerPlatform: "discord" });

    const persisted = new OfficeRegistry(fixture.stateDir);
    expect(persisted.getState().enabledPlatforms).toEqual(["discord", "slack"]);
    expect(persisted.getState().migrations).toHaveLength(2);
    expect(persisted.getMigration(fixture.rawConversationId)).toBeDefined();
    expect(persisted.getMigration(secondFixture.rawConversationId)).toBeDefined();
  });

  test("requires the canonical source path and rejects symlinked workspace roots", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");

    expect(() =>
      registry.prepareLegacyMigration({
        ...fixture,
        sourceDir: join(fixture.root, "arbitrary-host", "C123"),
      }),
    ).toThrow(/must be/);

    const realWorkspace = join(fixture.root, "real-workspace");
    mkdirSync(join(realWorkspace, "C123"), { recursive: true });
    const symlinkedWorkspace = join(fixture.root, "linked-workspace");
    symlinkSync(realWorkspace, symlinkedWorkspace, "dir");
    expect(() =>
      registry.prepareLegacyMigration({
        rawConversationId: "C123",
        sourceDir: join(symlinkedWorkspace, "C123"),
        workspaceRoot: symlinkedWorkspace,
      }),
    ).toThrow(/Workspace root/);
  });

  test("rejects a forged persisted target directory", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    registry.prepareLegacyMigration(fixture);

    const registryPath = join(fixture.stateDir, "office-registry.json");
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
      migrations: Array<{ targetDir?: string }>;
    };
    persisted.migrations[0].targetDir = join(fixture.root, "forged-target");
    writeFileSync(registryPath, `${JSON.stringify(persisted)}\n`);

    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/does not match/);
  });

  test("does not commit while the source still exists", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    registry.prepareLegacyMigration(fixture);
    const moving = registry.markMoving("C123");
    mkdirSync(moving.targetDir!);

    expect(() => registry.markCommitted("C123")).toThrow(/must be absent/);
    expect(registry.getMigration("C123")?.status).toBe("moving");
  });

  test("failed writes leave memory and disk unchanged", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    const before = registry.getState();
    const failing = new OfficeRegistry(fixture.stateDir, {
      writeState: throwRegistryWriteFailure,
    });

    expect(() => failing.enablePlatform("slack")).toThrow(/injected registry write failure/);
    expect(failing.getState()).toEqual(before);
    expect(new OfficeRegistry(fixture.stateDir).getState()).toEqual(before);
  });

  test("updates transition timestamps only for real transitions", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const prepared = registry.prepareLegacyMigration(fixture);
    const samePrepared = registry.prepareLegacyMigration(fixture);
    expect(samePrepared.updatedAt).toBe(prepared.updatedAt);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const moving = registry.markMoving("C123");
    expect(moving.updatedAt).not.toBe(prepared.updatedAt);
    vi.useRealTimers();
  });

  test("requires explicit owners to be enabled", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);

    expect(() => registry.prepareLegacyMigration({ ...fixture, ownerPlatform: "slack" })).toThrow(
      /is not enabled/,
    );
  });
});
