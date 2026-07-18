import { describe, expect, test } from "vitest";
import {
  assertConversationId,
  assertSessionKeyBelongsToConversation,
  assertSessionSuffix,
  conversationIdOf,
  deriveSessionKey,
  isThreadSessionKey,
  makeThreadSessionKey,
  threadSuffixOf,
} from "../src/sessions/session-key.js";

describe("session-key grammar", () => {
  test("bare conversation keys round-trip", () => {
    expect(isThreadSessionKey("C123")).toBe(false);
    expect(conversationIdOf("C123")).toBe("C123");
    expect(threadSuffixOf("C123")).toBeNull();
  });

  test("thread keys round-trip through make/parse", () => {
    const key = makeThreadSessionKey("C123", "1000.0001");
    expect(key).toBe("C123:1000.0001");
    expect(isThreadSessionKey(key)).toBe(true);
    expect(conversationIdOf(key)).toBe("C123");
    expect(threadSuffixOf(key)).toBe("1000.0001");
  });

  test("underscored conversation ids (GitHub) survive the grammar", () => {
    const key = makeThreadSessionKey("GH_owner_repo_42", "rc-7");
    expect(conversationIdOf(key)).toBe("GH_owner_repo_42");
    expect(threadSuffixOf(key)).toBe("rc-7");
  });

  test("a suffix containing ':' still parses at the first separator", () => {
    expect(conversationIdOf("C1:a:b")).toBe("C1");
    expect(threadSuffixOf("C1:a:b")).toBe("a:b");
  });

  test("conversation ids containing ':' are rejected at derivation", () => {
    expect(() => assertConversationId("bad:id")).toThrow(/must not contain/);
    expect(() => makeThreadSessionKey("bad:id", "1")).toThrow(/must not contain/);
    expect(() =>
      deriveSessionKey({ conversationId: "bad:id", ts: "1", thread_ts: undefined }),
    ).toThrow(/must not contain/);
  });

  test.each(["", ".", "..", "../other", "foo/bar", String.raw`foo\bar`, "bad\u0000id"])(
    "rejects path-dangerous conversation id %j",
    (conversationId) => {
      expect(() => assertConversationId(conversationId)).toThrow();
    },
  );

  test.each(["", ".", "..", "../other", "foo/bar", String.raw`foo\bar`, "bad\u0000id"])(
    "rejects path-dangerous session suffix %j",
    (suffix) => {
      expect(() => assertSessionSuffix(suffix)).toThrow();
      expect(() => makeThreadSessionKey("C1", suffix)).toThrow();
    },
  );

  test("keeps opaque suffix colons compatible", () => {
    expect(assertSessionSuffix("a:b")).toBe("a:b");
    expect(makeThreadSessionKey("C1", "a:b")).toBe("C1:a:b");
  });

  describe("session ownership", () => {
    test("accepts a bare conversation session", () => {
      expect(assertSessionKeyBelongsToConversation("C1", "C1")).toBe("C1");
    });

    test("accepts a scoped session belonging to the conversation", () => {
      expect(assertSessionKeyBelongsToConversation("C1:thread-1", "C1")).toBe("C1:thread-1");
    });

    test("rejects a session belonging to another conversation", () => {
      expect(() => assertSessionKeyBelongsToConversation("C2:thread-1", "C1")).toThrow(
        /does not belong/,
      );
    });
  });

  describe("deriveSessionKey", () => {
    test("honors a matching platform-computed session key", () => {
      expect(
        deriveSessionKey({ sessionKey: "C1", conversationId: "C1", ts: "9", thread_ts: "5" }),
      ).toBe("C1");
    });

    test("rejects a platform-computed session key from another conversation", () => {
      expect(() =>
        deriveSessionKey({
          sessionKey: "C2:thread-1",
          conversationId: "C1",
          ts: "9",
          thread_ts: "5",
        }),
      ).toThrow(/does not belong/);
    });

    test("falls back to the thread scope", () => {
      expect(deriveSessionKey({ conversationId: "C1", ts: "9", thread_ts: "5" })).toBe("C1:5");
    });

    test("thread-starting messages scope to their own ts", () => {
      expect(deriveSessionKey({ conversationId: "C1", ts: "9" })).toBe("C1:9");
    });
  });
});
