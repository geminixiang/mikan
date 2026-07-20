import { describe, expect, test } from "vitest";
import { conversationStorageScope } from "../src/sessions/conversation-storage-scope.js";

describe("conversation storage scope", () => {
  test("separates identical wire ids across platforms", () => {
    const discord = conversationStorageScope("discord", "123456789");
    const telegram = conversationStorageScope("telegram", "123456789");

    expect(discord.conversationId).toBe("123456789");
    expect(telegram.conversationId).toBe("123456789");
    expect(discord.storageKey).toMatch(/^discord-123456789-[a-f0-9]{16}$/);
    expect(telegram.storageKey).toMatch(/^telegram-123456789-[a-f0-9]{16}$/);
    expect(discord.storageKey).not.toBe(telegram.storageKey);
  });

  test("distinguishes ids that sanitize to the same readable segment", () => {
    const first = conversationStorageScope("github", "owner_repo#1");
    const second = conversationStorageScope("github", "owner-repo-1");

    expect(first.storageKey).not.toBe(second.storageKey);
  });

  test("rejects unsafe wire ids before deriving filesystem identity", () => {
    expect(() => conversationStorageScope("slack", "../other")).toThrow(
      "must not contain path separators",
    );
    expect(() => conversationStorageScope("slack", "channel:thread")).toThrow(
      'must not contain ":"',
    );
  });

  test("rejects unknown platform namespaces at runtime", () => {
    expect(() => conversationStorageScope("custom" as never, "C123")).toThrow(
      "Unsupported conversation storage platform",
    );
  });
});
