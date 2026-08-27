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
import { officeDir } from "../office/index.js";
import { createOfficeAddress, createWorkspace, OfficeRegistry } from "../office/index.js";

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

  test("a uniquely matching id format claims even with several platforms enabled", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("slack");
    registry.enablePlatform("discord");

    // "C123" is Slack's grammar and cannot be a Discord snowflake.
    const record = registry.prepareLegacyMigration(fixture);

    expect(record.status).toBe("prepared");
    expect(record.ownerPlatform).toBe("slack");
  });

  test("an id matching several enabled formats stays unowned", () => {
    const fixture = makeFixture();
    const digitsDir = join(fixture.workspaceRoot, "900100");
    mkdirSync(digitsDir, { recursive: true });
    const registry = new OfficeRegistry(fixture.stateDir);
    registry.enablePlatform("discord");
    registry.enablePlatform("telegram");

    const record = registry.prepareLegacyMigration({
      rawConversationId: "900100",
      sourceDir: digitsDir,
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(record.status).toBe("needs-owner");
    expect(record.ownerPlatform).toBeUndefined();
    expect(record.targetDir).toBeUndefined();
    expect(() => registry.markMoving("900100")).toThrow(/needs an owner/);
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

  test("records offices idempotently and separates platforms sharing a raw id", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    const discord = createOfficeAddress("discord", "900100");
    const telegram = createOfficeAddress("telegram", "900100");

    const first = registry.recordOffice(discord);
    const again = registry.recordOffice(discord);
    registry.recordOffice(telegram);

    expect(again).toEqual(first);
    expect(registry.getOffices()).toHaveLength(2);
    const reloaded = new OfficeRegistry(fixture.stateDir);
    expect(
      reloaded
        .getOffices()
        .map((record) => record.platform)
        .toSorted(),
    ).toEqual(["discord", "telegram"]);
  });

  test("rejects a registry file with duplicate office records", () => {
    const fixture = makeFixture();
    new OfficeRegistry(fixture.stateDir).recordOffice(createOfficeAddress("slack", "C123"));
    const path = join(fixture.stateDir, "office-registry.json");
    const state = JSON.parse(readFileSync(path, "utf-8")) as { offices: unknown[] };
    state.offices.push(state.offices[0]);
    writeFileSync(path, JSON.stringify(state));

    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Duplicate office record/);
  });

  test("reads registry files written before office records existed", () => {
    const fixture = makeFixture();
    writeFileSync(
      join(fixture.stateDir, "office-registry.json"),
      JSON.stringify({ version: 1, enabledPlatforms: ["slack"], migrations: [] }),
    );

    expect(new OfficeRegistry(fixture.stateDir).getOffices()).toEqual([]);
  });

  test("rejects a truncated (torn) registry file instead of starting empty", () => {
    const fixture = makeFixture();
    new OfficeRegistry(fixture.stateDir).recordOffice(createOfficeAddress("slack", "C123"));
    const path = join(fixture.stateDir, "office-registry.json");
    const raw = readFileSync(path, "utf-8");
    writeFileSync(path, raw.slice(0, raw.length / 2));

    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Invalid office registry JSON/);
  });

  test("rejects unknown registry versions and malformed shapes", () => {
    const fixture = makeFixture();
    const path = join(fixture.stateDir, "office-registry.json");

    writeFileSync(path, JSON.stringify({ version: 2, enabledPlatforms: [], migrations: [] }));
    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Invalid office registry version/);

    writeFileSync(path, JSON.stringify({ version: 1, enabledPlatforms: "slack" }));
    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Invalid office registry shape/);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, enabledPlatforms: ["matrix"], migrations: [] }),
    );
    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Unsupported platform/);
  });

  test("reload picks up changes another process wrote to the journal", () => {
    const fixture = makeFixture();
    const reader = new OfficeRegistry(fixture.stateDir);
    const writer = new OfficeRegistry(fixture.stateDir);

    writer.recordOffice(createOfficeAddress("slack", "C123"));
    expect(reader.getOffices()).toEqual([]);

    reader.reload();
    expect(reader.getOffices()).toContainEqual(
      expect.objectContaining({ platform: "slack", conversationId: "C123" }),
    );
  });

  describe("office.ensure()", () => {
    test("registers the office, creates its directory, and stays idempotent", () => {
      const fixture = makeFixture();
      const office = createWorkspace({
        root: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
      }).office(createOfficeAddress("slack", "C900"));

      const dir = office.ensure();

      expect(dir).toBe(office.dir);
      expect(dir).toBe(officeDir(fixture.workspaceRoot, office.address));
      expect(existsSync(dir)).toBe(true);
      expect(office.ensure()).toBe(dir);
      const registry = new OfficeRegistry(fixture.stateDir);
      expect(registry.getOffices()).toContainEqual(
        expect.objectContaining({ platform: "slack", conversationId: "C900" }),
      );
    });

    test("fails closed when the office path is a symlink", () => {
      const fixture = makeFixture();
      const office = createWorkspace({
        root: fixture.workspaceRoot,
        stateDir: fixture.stateDir,
      }).office(createOfficeAddress("slack", "C901"));
      mkdirSync(fixture.workspaceRoot, { recursive: true });
      symlinkSync(fixture.root, office.dir);

      expect(() => office.ensure()).toThrow(/regular non-symlink directory/);
    });
  });

  test("requires explicit owners to be enabled", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);

    expect(() => registry.prepareLegacyMigration({ ...fixture, ownerPlatform: "slack" })).toThrow(
      /is not enabled/,
    );
  });
});
