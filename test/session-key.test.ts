import { describe, expect, test } from "vitest";
import {
  assertConversationId,
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

  describe("deriveSessionKey", () => {
    test("honors a platform-computed session key verbatim", () => {
      expect(
        deriveSessionKey({ sessionKey: "C1", conversationId: "C1", ts: "9", thread_ts: "5" }),
      ).toBe("C1");
    });

    test("falls back to the thread scope", () => {
      expect(deriveSessionKey({ conversationId: "C1", ts: "9", thread_ts: "5" })).toBe("C1:5");
    });

    test("thread-starting messages scope to their own ts", () => {
      expect(deriveSessionKey({ conversationId: "C1", ts: "9" })).toBe("C1:9");
    });
  });
});
