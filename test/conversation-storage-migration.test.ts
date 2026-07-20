import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  migrateConversationStorage,
  readConversationStorageCompletion,
  readConversationStorageOwnershipManifest,
  writeConversationStorageCompletion,
} from "../src/sessions/conversation-storage-migration.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function workspace(): string {
  root = mkdtempSync(join(tmpdir(), "mikan-storage-migration-"));
  return root;
}

describe("conversation storage operator migration", () => {
  test("reads a strict explicit ownership manifest", () => {
    const workspaceRoot = workspace();
    const path = join(workspaceRoot, "owners.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, complete: true, owners: { "123": "discord" } }),
    );

    expect(readConversationStorageOwnershipManifest(path)).toEqual({
      version: 1,
      complete: true,
      owners: { "123": "discord" },
    });

    writeFileSync(
      path,
      JSON.stringify({ version: 1, complete: true, owners: { "123": "unknown" } }),
    );
    expect(() => readConversationStorageOwnershipManifest(path)).toThrow("unexpected JSON shape");
  });

  test("writes completion authority only for an explicitly complete manifest", () => {
    const workspaceRoot = workspace();
    const stateDir = join(workspaceRoot, "state");
    mkdirSync(stateDir);
    const manifest = { version: 1 as const, complete: true, owners: { "123": "discord" as const } };

    const record = writeConversationStorageCompletion({
      stateDir,
      workspaceRoot,
      manifest,
      now: () => new Date("2026-07-17T00:00:00Z"),
    });

    expect(record).toMatchObject({
      version: 1,
      workspaceRoot: expect.stringMatching(new RegExp(`${resolve(workspaceRoot)}$`)),
      completedAt: "2026-07-17T00:00:00.000Z",
    });
    expect(record.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(readConversationStorageCompletion({ stateDir, workspaceRoot })).toEqual(record);
    const otherWorkspace = join(workspaceRoot, "other");
    mkdirSync(otherWorkspace);
    expect(() =>
      readConversationStorageCompletion({ stateDir, workspaceRoot: otherWorkspace }),
    ).toThrow("completion record belongs to");
    expect(() =>
      writeConversationStorageCompletion({
        stateDir,
        workspaceRoot,
        manifest: { ...manifest, complete: false },
      }),
    ).toThrow("must declare complete: true");
  });

  test("migrates only declared owners and fences each legacy authority first", async () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "123"));
    mkdirSync(join(workspaceRoot, "456"));
    const fence = vi.fn().mockResolvedValue(undefined);

    const result = await migrateConversationStorage(
      { version: 1, complete: true, owners: { "123": "discord" } },
      {
        workspaceRoot,
        activePlatforms: ["discord", "telegram"],
        fenceLegacyAuthority: fence,
      },
    );

    expect(result).toEqual([
      expect.objectContaining({
        conversationId: "123",
        platform: "discord",
        migratedLegacy: true,
      }),
    ]);
    expect(fence).toHaveBeenCalledWith("discord", "123");
    expect(() => mkdirSync(join(workspaceRoot, "456"))).toThrow();
  });

  test("rejects an owner outside the explicitly active platform set", async () => {
    await expect(
      migrateConversationStorage(
        { version: 1, complete: true, owners: { "123": "telegram" } },
        { workspaceRoot: workspace(), activePlatforms: ["discord"] },
      ),
    ).rejects.toThrow("is not an active platform");
  });

  test("stops without publishing when strict fencing fails", async () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "123"));

    await expect(
      migrateConversationStorage(
        { version: 1, complete: true, owners: { "123": "discord" } },
        {
          workspaceRoot,
          activePlatforms: ["discord"],
          fenceLegacyAuthority: async () => {
            throw new Error("worker inventory unreachable");
          },
        },
      ),
    ).rejects.toThrow("worker inventory unreachable");
  });
});
