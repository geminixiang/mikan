import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveConversationStorage } from "../src/sessions/conversation-storage.js";
import { conversationStorageScope } from "../src/sessions/conversation-storage-scope.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function workspace(): string {
  root = mkdtempSync(join(tmpdir(), "mikan-conversation-storage-"));
  return root;
}

describe("conversation storage migration", () => {
  test("creates and reopens a scoped directory with a durable owner claim", async () => {
    const workspaceRoot = workspace();
    const first = await resolveConversationStorage({
      workspaceRoot,
      platform: "discord",
      conversationId: "123",
      activePlatforms: ["discord"],
    });
    const second = await resolveConversationStorage({
      workspaceRoot,
      platform: "discord",
      conversationId: "123",
      activePlatforms: ["discord"],
    });

    expect(first.migratedLegacy).toBe(false);
    expect(second).toEqual(first);
    expect(basename(first.conversationDir)).toBe(first.storageKey);
    const claimPath = join(first.conversationDir, ".mikan-conversation-storage-claim.json");
    expect(statSync(claimPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toMatchObject({
      version: 1,
      platform: "discord",
      conversationId: "123",
      storageKey: first.storageKey,
    });
  });

  test("atomically moves the complete legacy storage for a single platform", async () => {
    const workspaceRoot = workspace();
    const legacyDir = join(workspaceRoot, "C123");
    mkdirSync(join(legacyDir, "sessions"), { recursive: true });
    writeFileSync(join(legacyDir, "log.jsonl"), "legacy\n");
    writeFileSync(join(legacyDir, "sessions", "session.jsonl"), "session\n");

    const result = await resolveConversationStorage({
      workspaceRoot,
      platform: "slack",
      conversationId: "C123",
      activePlatforms: ["slack"],
    });

    expect(result.migratedLegacy).toBe(true);
    expect(() => statSync(legacyDir)).toThrow();
    expect(readFileSync(join(result.conversationDir, "log.jsonl"), "utf8")).toBe("legacy\n");
    expect(readFileSync(join(result.conversationDir, "sessions", "session.jsonl"), "utf8")).toBe(
      "session\n",
    );
  });

  test("does not publish scoped storage until legacy authority is fenced", async () => {
    const workspaceRoot = workspace();
    const legacyDir = join(workspaceRoot, "C123");
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "log.jsonl"), "legacy\n");
    let releaseFence!: () => void;
    const fence = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });

    const resolving = resolveConversationStorage({
      workspaceRoot,
      platform: "slack",
      conversationId: "C123",
      activePlatforms: ["slack"],
      fenceLegacyAuthority: () => fence,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(statSync(legacyDir).isDirectory()).toBe(true);
    const scope = conversationStorageScope("slack", "C123");
    expect(() => statSync(join(workspaceRoot, scope.storageKey))).toThrow();

    releaseFence();
    const result = await resolving;
    expect(result.migratedLegacy).toBe(true);
    expect(statSync(result.conversationDir).isDirectory()).toBe(true);
  });

  test("leaves claimed legacy storage unpublished when fencing fails", async () => {
    const workspaceRoot = workspace();
    const legacyDir = join(workspaceRoot, "C123");
    mkdirSync(legacyDir);

    await expect(
      resolveConversationStorage({
        workspaceRoot,
        platform: "slack",
        conversationId: "C123",
        activePlatforms: ["slack"],
        fenceLegacyAuthority: async () => {
          throw new Error("worker unreachable");
        },
      }),
    ).rejects.toThrow("worker unreachable");

    expect(statSync(legacyDir).isDirectory()).toBe(true);
    expect(
      JSON.parse(readFileSync(join(legacyDir, ".mikan-conversation-storage-claim.json"), "utf8")),
    ).toMatchObject({ platform: "slack", conversationId: "C123" });
  });

  test("fails closed instead of assigning legacy history in multi-platform mode", async () => {
    const workspaceRoot = workspace();
    mkdirSync(join(workspaceRoot, "123"));

    await expect(
      resolveConversationStorage({
        workspaceRoot,
        platform: "discord",
        conversationId: "123",
        activePlatforms: ["discord", "telegram"],
      }),
    ).rejects.toThrow("ownership is ambiguous");
  });

  test("rejects simultaneous scoped and legacy authorities", async () => {
    const workspaceRoot = workspace();
    const scoped = await resolveConversationStorage({
      workspaceRoot,
      platform: "telegram",
      conversationId: "123",
      activePlatforms: ["telegram"],
    });
    mkdirSync(join(workspaceRoot, "123"));

    await expect(
      resolveConversationStorage({
        workspaceRoot,
        platform: "telegram",
        conversationId: "123",
        activePlatforms: ["telegram"],
      }),
    ).rejects.toThrow("both scoped and legacy directories exist");
    expect(statSync(scoped.conversationDir).isDirectory()).toBe(true);
  });

  test("concurrent legacy migration converges after both fences complete", async () => {
    const workspaceRoot = workspace();
    const legacyDir = join(workspaceRoot, "C123");
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "log.jsonl"), "legacy\n");
    let fenceCalls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const options = {
      workspaceRoot,
      platform: "slack" as const,
      conversationId: "C123",
      activePlatforms: ["slack" as const],
      fenceLegacyAuthority: async () => {
        fenceCalls += 1;
        if (fenceCalls === 2) release();
        await barrier;
      },
    };

    const [first, second] = await Promise.all([
      resolveConversationStorage(options),
      resolveConversationStorage(options),
    ]);

    expect(first.conversationDir).toBe(second.conversationDir);
    expect([first.migratedLegacy, second.migratedLegacy].toSorted()).toEqual([false, true]);
    expect(readFileSync(join(first.conversationDir, "log.jsonl"), "utf8")).toBe("legacy\n");
  });

  test("rejects symlinked legacy or scoped storage", async () => {
    const workspaceRoot = workspace();
    const outside = join(workspaceRoot, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(workspaceRoot, "C123"));

    await expect(
      resolveConversationStorage({
        workspaceRoot,
        platform: "slack",
        conversationId: "C123",
        activePlatforms: ["slack"],
      }),
    ).rejects.toThrow("legacy conversation storage must be a real directory");
  });

  test("concurrent first resolution converges on one claimed directory", async () => {
    const workspaceRoot = workspace();
    const options = {
      workspaceRoot,
      platform: "discord" as const,
      conversationId: "123",
      activePlatforms: ["discord" as const],
    };

    const [first, second] = await Promise.all([
      resolveConversationStorage(options),
      resolveConversationStorage(options),
    ]);

    expect(first.conversationDir).toBe(second.conversationDir);
    expect(first.storageKey).toBe(second.storageKey);
  });

  test("rejects a scoped directory without a readable matching claim", async () => {
    const workspaceRoot = workspace();
    const first = await resolveConversationStorage({
      workspaceRoot,
      platform: "github",
      conversationId: "repo-1",
      activePlatforms: ["github"],
    });
    writeFileSync(join(first.conversationDir, ".mikan-conversation-storage-claim.json"), "{}\n");

    await expect(
      resolveConversationStorage({
        workspaceRoot,
        platform: "github",
        conversationId: "repo-1",
        activePlatforms: ["github"],
      }),
    ).rejects.toThrow("claim does not match");
  });
});
