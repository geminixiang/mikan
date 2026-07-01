import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let stateDir: string;
let conversationDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-settings-state-"));
  conversationDir = mkdtempSync(join(tmpdir(), "mikan-settings-conv-"));
  previousStateDir = process.env.STATE_DIR;
  process.env.STATE_DIR = stateDir;
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(conversationDir, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
});

function writeGlobalSettings(config: unknown): void {
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify(config));
}

function writeConversationSettings(config: unknown): void {
  writeFileSync(join(conversationDir, "settings.json"), JSON.stringify(config));
}

describe("resolveConversationSettings nested-field merge", () => {
  test("a conversation overriding one retry field keeps the other global retry fields", async () => {
    writeGlobalSettings({
      llm: { provider: "anthropic", model: "claude-sonnet-5", thinkingLevel: "off" },
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 5000 },
    });
    writeConversationSettings({ retry: { maxRetries: 5 } });

    const { resolveConversationSettings } = await import("../src/harness/settings-manager.js");
    const resolved = resolveConversationSettings(conversationDir);

    expect(resolved.retry).toEqual({ enabled: true, maxRetries: 5, baseDelayMs: 5000 });
  });

  test("a conversation overriding one compaction field keeps the other global compaction fields", async () => {
    writeGlobalSettings({
      llm: { provider: "anthropic", model: "claude-sonnet-5", thinkingLevel: "off" },
      compaction: { enabled: true, reserveTokens: 20000, keepRecentTokens: 30000 },
    });
    writeConversationSettings({ compaction: { keepRecentTokens: 10000 } });

    const { resolveConversationSettings } = await import("../src/harness/settings-manager.js");
    const resolved = resolveConversationSettings(conversationDir);

    expect(resolved.compaction).toEqual({
      enabled: true,
      reserveTokens: 20000,
      keepRecentTokens: 10000,
    });
  });

  test("a conversation with no retry/compaction override inherits the global values untouched", async () => {
    writeGlobalSettings({
      llm: { provider: "anthropic", model: "claude-sonnet-5", thinkingLevel: "off" },
      retry: { enabled: false, maxRetries: 1, baseDelayMs: 1000 },
    });
    writeConversationSettings({ llm: { model: "claude-opus-4-8" } });

    const { resolveConversationSettings } = await import("../src/harness/settings-manager.js");
    const resolved = resolveConversationSettings(conversationDir);

    expect(resolved.model).toBe("claude-opus-4-8");
    expect(resolved.retry).toEqual({ enabled: false, maxRetries: 1, baseDelayMs: 1000 });
  });
});
