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
import { afterEach, describe, expect, test } from "vitest";
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
      new OfficeRegistry(fixture.stateDir, { lockTimeoutMs: 50 }).recordOffice(
        createOfficeAddress("slack", "C123"),
      ),
    ).toThrow(/Timed out acquiring office registry lock/);
    expect(existsSync(lockDir)).toBe(true);
  });

  test("failed writes leave memory and disk unchanged", () => {
    const fixture = makeFixture();
    const registry = new OfficeRegistry(fixture.stateDir);
    const before = registry.getOffices();
    const failing = new OfficeRegistry(fixture.stateDir, {
      writeState: throwRegistryWriteFailure,
    });

    expect(() => failing.recordOffice(createOfficeAddress("slack", "C123"))).toThrow(
      /injected registry write failure/,
    );
    expect(failing.getOffices()).toEqual(before);
    expect(new OfficeRegistry(fixture.stateDir).getOffices()).toEqual(before);
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

    writeFileSync(path, JSON.stringify({ version: 2, offices: [] }));
    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Invalid office registry at/);

    writeFileSync(path, JSON.stringify({ version: 1, offices: "slack" }));
    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Invalid office registry at/);

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        offices: [{ platform: "matrix", conversationId: "C1", recordedAt: "2026-01-01" }],
      }),
    );
    expect(() => new OfficeRegistry(fixture.stateDir)).toThrow(/Unsupported platform/);
  });

  test("ignores fields that only prerelease registries wrote", () => {
    const fixture = makeFixture();
    const office = { platform: "slack", conversationId: "C123", recordedAt: "2026-01-01" };
    writeFileSync(
      join(fixture.stateDir, "office-registry.json"),
      JSON.stringify({
        version: 1,
        enabledPlatforms: ["slack"],
        offices: [office],
        migrations: [],
      }),
    );

    expect(new OfficeRegistry(fixture.stateDir).getOffices()).toEqual([office]);
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
});
