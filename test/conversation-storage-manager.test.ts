import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConversationStorageManager } from "../src/sessions/conversation-storage-manager.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function workspace(): string {
  root = mkdtempSync(join(tmpdir(), "mikan-storage-manager-"));
  return root;
}

describe("ConversationStorageManager", () => {
  test("shares one legacy fence transaction across concurrent consumers", async () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "C123"));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fence = vi.fn(() => barrier);
    const manager = new ConversationStorageManager({
      workspaceRoot,
      activePlatforms: ["slack"],
      fenceLegacyAuthority: fence,
    });

    const first = manager.resolve("slack", "C123");
    const second = manager.resolve("slack", "C123");
    expect(first).toBe(second);
    await vi.waitFor(() => expect(fence).toHaveBeenCalledOnce());
    release();

    expect(await first).toEqual(await second);
    expect(fence).toHaveBeenCalledWith("slack", "C123");
  });

  test("evicts failed resolutions so fencing can be retried", async () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "C123"));
    const fence = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("partition"))
      .mockResolvedValueOnce();
    const manager = new ConversationStorageManager({
      workspaceRoot,
      activePlatforms: ["slack"],
      fenceLegacyAuthority: fence,
    });

    await expect(manager.resolve("slack", "C123")).rejects.toThrow("partition");
    await expect(manager.resolve("slack", "C123")).resolves.toMatchObject({ migratedLegacy: true });
    expect(fence).toHaveBeenCalledTimes(2);
  });

  test("keeps same wire ids isolated by platform", async () => {
    const manager = new ConversationStorageManager({
      workspaceRoot: workspace(),
      activePlatforms: ["discord", "telegram"],
    });

    const [discord, telegram] = await Promise.all([
      manager.resolve("discord", "123"),
      manager.resolve("telegram", "123"),
    ]);

    expect(discord.conversationDir).not.toBe(telegram.conversationDir);
  });
});
