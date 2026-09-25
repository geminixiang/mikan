import { describe, expect, test, vi } from "vitest";
import type { CommandContext } from "../adapters/commands/types.js";
import {
  formatCommandSummary,
  isPrivateConversation,
  replyPrivatelyWithContext,
} from "../adapters/commands/utils.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { ConversationEvent, ConversationResponder, MessagingBot } from "../types.js";
import type { VaultManager } from "../vault/types.js";

interface ContextOverrides {
  privateConversation?: boolean;
  bot?: Partial<MessagingBot>;
}

function fakeResponder(): ConversationResponder {
  return {
    respond: vi.fn(async () => {}),
    replaceResponse: vi.fn(async () => {}),
    respondDiagnostic: vi.fn(async () => {}),
    respondToolResult: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    setWorking: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {}),
    deleteResponse: vi.fn(async () => {}),
  };
}

function fakeBot(overrides: Partial<MessagingBot> = {}): MessagingBot {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    postMessage: vi.fn(async () => "ts-1"),
    updateMessage: vi.fn(async () => {}),
    enqueueEvent: vi.fn(() => true),
    getMessagingInfo: () => ({ name: "slack", formattingGuide: "", channels: [], users: [] }),
    ...overrides,
  };
}

function fakeVaultManager(): VaultManager {
  return {
    hasEntry: () => false,
    resolve: () => undefined,
    list: () => [],
    isEnabled: () => false,
    upsertEnv: () => {},
    deleteEnvKey: () => false,
    upsertFile: () => {},
    listSharedVaults: () => [],
    deleteSharedVault: () => false,
    copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
  };
}

function makeContext(overrides: ContextOverrides = {}): CommandContext {
  return {
    bot: fakeBot(overrides.bot),
    responder: fakeResponder(),
    platform: "slack",
    address: createOfficeAddress("slack", "C123"),
    platformUserId: "U123",
    conversationId: "C123",
    sessionKey: "C123",
    commandText: "",
    privateConversation: overrides.privateConversation ?? false,
    services: {
      workspace: createWorkspace({
        root: "/tmp/no-such-working-dir",
        stateDir: "/tmp/no-such-working-dir/state",
      }),
      sandbox: { type: "host" },
      vaultManager: fakeVaultManager(),
      linkTokenStore: { create: () => ({ token: "tok-link" }) },
      sessionViewTokenStore: { create: () => ({ token: "tok-sv" }) },
      adminTokenStore: { create: () => ({ token: "tok-admin" }) },
    },
  };
}

function makeEvent(overrides: Partial<ConversationEvent>): ConversationEvent {
  return {
    type: "message",
    address: createOfficeAddress("slack", "C123"),
    conversationKind: "shared",
    ts: "1",
    user: "U123",
    text: "",
    ...overrides,
  };
}

describe("formatCommandSummary", () => {
  test("formats summary with title and lines", () => {
    const result = formatCommandSummary("Config", ["key: value", "model: gpt-4"]);
    expect(result).toBe("_Config_\nkey: value\nmodel: gpt-4");
  });

  test("filters empty lines", () => {
    const result = formatCommandSummary("Status", ["ok", "", "done"]);
    expect(result).toBe("_Status_\nok\ndone");
  });

  test("compacts more than 2 non-empty lines", () => {
    const result = formatCommandSummary("Info", ["a", "b", "c", "d"]);
    expect(result).toBe("_Info_\na\nb · c · d");
  });
});

describe("isPrivateConversation", () => {
  test("returns true for direct conversation kind", () => {
    expect(isPrivateConversation(makeEvent({ conversationKind: "direct" }))).toBe(true);
  });

  test("returns true for dm type", () => {
    expect(isPrivateConversation(makeEvent({ type: "dm" }))).toBe(true);
  });

  test("returns true for private_command type", () => {
    expect(isPrivateConversation(makeEvent({ type: "private_command" }))).toBe(true);
  });

  test("returns false for shared conversation kind", () => {
    expect(isPrivateConversation(makeEvent({ conversationKind: "shared" }))).toBe(false);
  });

  test("returns false for public message type", () => {
    expect(isPrivateConversation(makeEvent({ type: "message" }))).toBe(false);
  });
});

describe("replyPrivatelyWithContext", () => {
  test("uses diagnostic responder for private conversation", async () => {
    const context = makeContext({ privateConversation: true });
    await replyPrivatelyWithContext(context, "hello");
    expect(context.responder.respondDiagnostic).toHaveBeenCalledWith("hello", undefined);
  });

  test("prefers postPrivateDiagnostic when available", async () => {
    const postPrivateDiagnostic = vi.fn();
    const context = makeContext({
      bot: { postPrivateDiagnostic },
    });
    await replyPrivatelyWithContext(context, "hello", { style: "error" });
    expect(postPrivateDiagnostic).toHaveBeenCalledWith("C123", "U123", "hello", { style: "error" });
  });

  test("falls back to postPrivate when available", async () => {
    const postPrivate = vi.fn();
    const context = makeContext({
      bot: { postPrivate },
    });
    await replyPrivatelyWithContext(context, "hello");
    expect(postPrivate).toHaveBeenCalledWith("C123", "U123", "hello");
  });

  test("falls back to diagnostic responder", async () => {
    const context = makeContext();
    await replyPrivatelyWithContext(context, "hello");
    expect(context.responder.respondDiagnostic).toHaveBeenCalledWith("hello", undefined);
  });
});
