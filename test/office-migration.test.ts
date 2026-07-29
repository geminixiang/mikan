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
import { officeDir } from "../src/office/address.js";
import { createOfficeAddress, officeKey } from "../src/office/index.js";
import { legacyConversationCredentialKey } from "../src/sandbox/identity.js";
import {
  buildContainerBindTranslator,
  formatUnmigratedOfficesError,
  migrateLegacyOffices,
} from "../src/office/index.js";
import { OfficeRegistry } from "../src/office/index.js";

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

    expect(summary).toEqual({
      migrated: [],
      recovered: [],
      unowned: [],
      failed: [],
      vaultKeysMigrated: [],
      vaultConflicts: [],
      stateDirsMigrated: [],
      stateDirConflicts: [],
    });
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

    expect(summary).toEqual({
      migrated: [],
      recovered: [],
      unowned: [],
      failed: [],
      vaultKeysMigrated: [],
      vaultConflicts: [],
      stateDirsMigrated: [],
      stateDirConflicts: [],
    });
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

  test("moves legacy conversation vault keys for registered offices", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    const legacyVault = join(stateDir, "vaults", legacyConversationCredentialKey("C123"));
    mkdirSync(legacyVault, { recursive: true });
    writeFileSync(join(legacyVault, "env"), "TOKEN=secret\n");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.vaultKeysMigrated).toEqual(["C123"]);
    expect(summary.vaultConflicts).toEqual([]);
    const target = join(stateDir, "vaults", officeKey(createOfficeAddress("slack", "C123")));
    expect(readFileSync(join(target, "env"), "utf-8")).toContain("TOKEN=secret");
    expect(existsSync(legacyVault)).toBe(false);
  });

  test("reports a vault-key conflict instead of clobbering either side", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    const legacyVault = join(stateDir, "vaults", legacyConversationCredentialKey("C123"));
    mkdirSync(legacyVault, { recursive: true });
    const target = join(stateDir, "vaults", officeKey(createOfficeAddress("slack", "C123")));
    mkdirSync(target, { recursive: true });

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.vaultConflicts).toEqual(["C123"]);
    expect(existsSync(legacyVault)).toBe(true);
    expect(formatUnmigratedOfficesError(summary)).toContain("merge them manually");
  });

  test("leaves shared and unrecognized vault directories alone", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    for (const name of ["shared/claw", "u1-ancient", "d0ar8t4q61e"]) {
      mkdirSync(join(stateDir, "vaults", name), { recursive: true });
    }

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.vaultKeysMigrated).toEqual([]);
    for (const name of ["shared/claw", "u1-ancient", "d0ar8t4q61e"]) {
      expect(existsSync(join(stateDir, "vaults", name))).toBe(true);
    }
  });

  test("moves the host state tree (settings, extensions, data) in one rename", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    const legacyState = join(stateDir, "conversations", "C123");
    mkdirSync(join(legacyState, "extension-data", "probe"), { recursive: true });
    writeFileSync(join(legacyState, "settings.json"), "{}\n");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.stateDirsMigrated).toEqual(["C123"]);
    const target = join(stateDir, "conversations", officeKey(createOfficeAddress("slack", "C123")));
    expect(existsSync(join(target, "settings.json"))).toBe(true);
    expect(existsSync(join(target, "extension-data", "probe"))).toBe(true);
    expect(existsSync(legacyState)).toBe(false);
  });

  test("reports a state-dir conflict instead of clobbering either side", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    mkdirSync(join(stateDir, "conversations", "C123"), { recursive: true });
    mkdirSync(join(stateDir, "conversations", officeKey(createOfficeAddress("slack", "C123"))), {
      recursive: true,
    });

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.stateDirConflicts).toEqual(["C123"]);
    expect(formatUnmigratedOfficesError(summary)).toContain("<state-dir>/conversations");
  });

  test("multi-platform: verifiable formats claim automatically, prod-style", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C0AB12CD3");
    makeLegacyOffice(workspaceRoot, "D0EF45GH6");
    makeLegacyOffice(workspaceRoot, "GH_livingbio_genv-queue_1652");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack", "github"],
    });

    expect(summary.unowned).toEqual([]);
    expect(summary.migrated.toSorted()).toEqual([
      "C0AB12CD3",
      "D0EF45GH6",
      "GH_livingbio_genv-queue_1652",
    ]);
    expect(existsSync(officeDir(workspaceRoot, createOfficeAddress("slack", "C0AB12CD3")))).toBe(
      true,
    );
    expect(
      existsSync(
        officeDir(workspaceRoot, createOfficeAddress("github", "GH_livingbio_genv-queue_1652")),
      ),
    ).toBe(true);
  });

  test("a github-format dir is never claimed by a slack-only deployment", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "GH_octo_widgets_5");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.unowned).toEqual(["GH_octo_widgets_5"]);
    expect(existsSync(join(workspaceRoot, "GH_octo_widgets_5"))).toBe(true);
  });

  test("bare digits stay ambiguous under telegram+discord; negative ids are telegram's", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "900100");
    makeLegacyOffice(workspaceRoot, "-1001234567890");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["discord", "telegram"],
    });

    expect(summary.unowned).toEqual(["900100"]);
    expect(summary.migrated).toEqual(["-1001234567890"]);
    expect(
      existsSync(officeDir(workspaceRoot, createOfficeAddress("telegram", "-1001234567890"))),
    ).toBe(true);
  });

  test("workspace directories without office markers are skipped, not claimed", () => {
    const { stateDir, workspaceRoot } = makeFixture();
    makeLegacyOffice(workspaceRoot, "C123");
    // A repo the agent cloned into a trusted workspace root: no log.jsonl,
    // no sessions/ — not an office, must stay put and not block boot.
    mkdirSync(join(workspaceRoot, "pi-mono"), { recursive: true });
    writeFileSync(join(workspaceRoot, "pi-mono", "README.md"), "repo\n");

    const summary = migrateLegacyOffices({
      workspaceRoot,
      stateDir,
      enabledPlatforms: ["slack"],
    });

    expect(summary.migrated).toEqual(["C123"]);
    expect(summary.unowned).toEqual([]);
    expect(existsSync(join(workspaceRoot, "pi-mono", "README.md"))).toBe(true);
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

describe("buildContainerBindTranslator", () => {
  const office = { platform: "slack", conversationId: "C123", recordedAt: "t" } as const;
  const translate = buildContainerBindTranslator({
    offices: [office],
    workspaceRoot: "/w",
    stateDir: "/s",
  });
  const key = officeKey(createOfficeAddress("slack", "C123"));

  test("rewrites workspace, state-tree, and vault sources plus the guest segment", () => {
    expect(translate("/w/C123:/workspace/C123")).toBe(`/w/${key}:/workspace/${key}`);
    expect(translate("/s/conversations/C123/extensions:/mikan/packages/p/skills:ro")).toBe(
      `/s/conversations/${key}/extensions:/mikan/packages/p/skills:ro`,
    );
    const legacyVault = legacyConversationCredentialKey("C123");
    expect(translate(`/s/vaults/${legacyVault}/.ssh:/root/.ssh`)).toBe(
      `/s/vaults/${key}/.ssh:/root/.ssh`,
    );
  });

  test("leaves unrelated binds untouched and never partial-matches ids", () => {
    expect(translate("/w/MEMORY.md:/workspace/MEMORY.md")).toBe(
      "/w/MEMORY.md:/workspace/MEMORY.md",
    );
    expect(translate("/w:/workspace")).toBe("/w:/workspace");
    expect(translate("/w/C1234:/workspace/C1234")).toBe("/w/C1234:/workspace/C1234");
  });
});
