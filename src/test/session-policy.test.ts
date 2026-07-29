import { describe, expect, test } from "vitest";
import { inferConversationKind, resolveChatSessionKey } from "../sessions/policy.js";

describe("resolveChatSessionKey", () => {
  test("direct top-level conversations use one persistent session", () => {
    expect(
      resolveChatSessionKey({
        conversationId: "DM1",
        conversationKind: "direct",
        messageId: "M1",
      }),
    ).toBe("DM1");
  });

  test("direct thread replies use the persistent conversation session by default", () => {
    expect(
      resolveChatSessionKey({
        conversationId: "DM1",
        conversationKind: "direct",
        messageId: "M2",
        threadTs: "M1",
      }),
    ).toBe("DM1");
  });

  test("direct thread replies can opt into scoped sessions", () => {
    expect(
      resolveChatSessionKey({
        conversationId: "DM1",
        conversationKind: "direct",
        messageId: "M2",
        threadTs: "M1",
        scopeDirectThreads: true,
      }),
    ).toBe("DM1:M1");
  });

  test("shared top-level messages use message-scoped sessions by default", () => {
    expect(
      resolveChatSessionKey({
        conversationId: "C1",
        conversationKind: "shared",
        messageId: "M1",
      }),
    ).toBe("C1:M1");
  });

  test("shared top-level messages can use persistent conversation sessions", () => {
    expect(
      resolveChatSessionKey({
        conversationId: "C1",
        conversationKind: "shared",
        messageId: "M1",
        persistentTopLevel: true,
      }),
    ).toBe("C1");
  });

  test("shared thread replies use thread-scoped sessions", () => {
    expect(
      resolveChatSessionKey({
        conversationId: "C1",
        conversationKind: "shared",
        messageId: "M2",
        threadTs: "M1",
      }),
    ).toBe("C1:M1");
  });
});

describe("inferConversationKind", () => {
  test("infers Slack direct conversations from D-prefixed IDs", () => {
    expect(inferConversationKind("slack", "D123")).toBe("direct");
    expect(inferConversationKind("slack", "C123")).toBe("shared");
  });

  test("infers Telegram shared conversations from negative chat IDs", () => {
    expect(inferConversationKind("telegram", "-100123")).toBe("shared");
    expect(inferConversationKind("telegram", "123")).toBe("direct");
  });

  test("infers Discord direct conversations from synthetic DM IDs", () => {
    expect(inferConversationKind("discord", "DM123")).toBe("direct");
    expect(inferConversationKind("discord", "123")).toBe("shared");
  });
});
