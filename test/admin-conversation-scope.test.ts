import { describe, expect, test } from "vitest";
import {
  adminConversationScopeKey,
  parseAdminConversationScopeKey,
  withAdminScopeKey,
} from "../src/web/admin/conversation-scope.js";

describe("admin conversation scope", () => {
  test("round-trips same wire id independently by platform", () => {
    expect(adminConversationScopeKey("discord", "123")).toBe("discord:123");
    expect(adminConversationScopeKey("telegram", "123")).toBe("telegram:123");
    expect(parseAdminConversationScopeKey("discord:123")).toEqual({
      platform: "discord",
      conversationId: "123",
    });
  });

  test("rejects unknown platforms and path-bearing ids", () => {
    expect(() => parseAdminConversationScopeKey("other:123")).toThrow(
      "Invalid admin conversation platform",
    );
    expect(() => parseAdminConversationScopeKey("discord:../events")).toThrow("path separators");
  });

  test("adds the stable UI/API scope key without changing storage identity", () => {
    expect(
      withAdminScopeKey({
        platform: "telegram",
        conversationId: "123",
        storageKey: "telegram-123-hash",
        conversationDir: "/workspace/telegram-123-hash",
      }),
    ).toMatchObject({ scopeKey: "telegram:123", storageKey: "telegram-123-hash" });
  });
});
