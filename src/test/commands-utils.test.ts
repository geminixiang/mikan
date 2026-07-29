import { describe, expect, test, vi } from "vitest";
import {
  formatCommandSummary,
  isPrivateConversation,
  replyDiagnosticWithContext,
  replyPrivatelyWithContext,
} from "../commands/utils.js";

function makeContext(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    privateConversation: false,
    conversationId: "C123",
    platformUserId: "U123",
    responder: {
      setTyping: vi.fn(),
      setWorking: vi.fn(),
      respondDiagnostic: vi.fn(),
    },
    bot: {},
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
    expect(isPrivateConversation({ conversationKind: "direct" } as any)).toBe(true);
  });

  test("returns true for dm type", () => {
    expect(isPrivateConversation({ type: "dm" } as any)).toBe(true);
  });

  test("returns true for private_command type", () => {
    expect(isPrivateConversation({ type: "private_command" } as any)).toBe(true);
  });

  test("returns false for channel conversation kind", () => {
    expect(isPrivateConversation({ conversationKind: "channel" } as any)).toBe(false);
  });

  test("returns false for public message type", () => {
    expect(isPrivateConversation({ type: "message" } as any)).toBe(false);
  });
});

describe("replyDiagnosticWithContext", () => {
  test("clears typing/working and responds diagnostic", async () => {
    const responder = {
      setTyping: vi.fn(),
      setWorking: vi.fn(),
      respondDiagnostic: vi.fn(),
    };

    await replyDiagnosticWithContext(responder as any, "hello", { style: "muted" });

    expect(responder.setTyping).toHaveBeenCalledWith(false);
    expect(responder.setWorking).toHaveBeenCalledWith(false);
    expect(responder.respondDiagnostic).toHaveBeenCalledWith("hello", { style: "muted" });
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
