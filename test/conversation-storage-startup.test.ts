import { describe, expect, test } from "vitest";
import { assertConversationStorageStartup } from "../src/sessions/conversation-storage-startup.js";
import type { ConversationStorageCompletionRecord } from "../src/sessions/types.js";

const remote = { type: "gondolin", profile: "remote" } as const;
const completion: ConversationStorageCompletionRecord = {
  version: 1,
  workspaceRoot: "/workspace",
  manifestDigest: "a".repeat(64),
  completedAt: "2026-07-17T00:00:00.000Z",
};

describe("conversation storage startup policy", () => {
  test("rejects overlapping Discord/Telegram before migration", () => {
    expect(() =>
      assertConversationStorageStartup({
        sandbox: remote,
        activePlatforms: ["discord", "telegram"],
      }),
    ).toThrow("cannot run Discord and Telegram together");
  });

  test("allows completed Discord/Telegram storage with Admin", () => {
    expect(() =>
      assertConversationStorageStartup({
        sandbox: remote,
        activePlatforms: ["discord", "telegram"],
        completion,
      }),
    ).not.toThrow();
  });

  test("allows completed GitHub storage", () => {
    expect(() =>
      assertConversationStorageStartup({
        sandbox: remote,
        activePlatforms: ["github", "discord"],
        completion,
      }),
    ).not.toThrow();
  });

  test("allows completed all-platform storage", () => {
    expect(() =>
      assertConversationStorageStartup({
        sandbox: remote,
        activePlatforms: ["slack", "discord", "telegram", "github"],
        completion,
      }),
    ).not.toThrow();
  });
});
