import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  findConversationStorage,
  listConversationStorage,
} from "../src/sessions/conversation-storage-catalog.js";
import { resolveConversationStorage } from "../src/sessions/conversation-storage.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function workspace(): string {
  root = mkdtempSync(join(tmpdir(), "mikan-storage-catalog-"));
  return root;
}

describe("conversation storage catalog", () => {
  test("lists same wire id independently from durable scoped claims", async () => {
    const workspaceRoot = workspace();
    await Promise.all([
      resolveConversationStorage({
        workspaceRoot,
        platform: "discord",
        conversationId: "123",
        activePlatforms: ["discord", "telegram"],
      }),
      resolveConversationStorage({
        workspaceRoot,
        platform: "telegram",
        conversationId: "123",
        activePlatforms: ["discord", "telegram"],
      }),
    ]);

    const entries = listConversationStorage({ workspaceRoot, scoped: true });

    expect(entries.map(({ platform, conversationId }) => ({ platform, conversationId }))).toEqual([
      { platform: "discord", conversationId: "123" },
      { platform: "telegram", conversationId: "123" },
    ]);
    expect(findConversationStorage(entries, "discord", "123")?.conversationDir).not.toBe(
      findConversationStorage(entries, "telegram", "123")?.conversationDir,
    );
  });

  test("fails closed on unclaimed or corrupt directories in scoped mode", () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "unclaimed"));
    expect(() => listConversationStorage({ workspaceRoot, scoped: true })).toThrow(
      "Cannot read conversation storage claim",
    );

    writeFileSync(join(workspaceRoot, "unclaimed", ".mikan-conversation-storage-claim.json"), "{}");
    expect(() => listConversationStorage({ workspaceRoot, scoped: true })).toThrow(
      "Invalid conversation storage claim",
    );
  });

  test("preserves raw directory behavior in legacy mode", () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "C123"));
    mkdirSync(join(workspaceRoot, "skills"));

    expect(
      listConversationStorage({ workspaceRoot, scoped: false, legacyPlatform: "slack" }),
    ).toEqual([
      {
        platform: "slack",
        conversationId: "C123",
        storageKey: "C123",
        conversationDir: join(workspaceRoot, "C123"),
      },
    ]);
  });
});
