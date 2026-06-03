import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryLinkTokenStore } from "../src/web/login/store.js";

describe("InMemoryLinkTokenStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("consume is one-shot", () => {
    const store = new InMemoryLinkTokenStore();
    const token = store.create("slack", "U123", "D123", "vault-u123", "github");

    expect(store.peek(token.token)).toMatchObject({ platformUserId: "U123" });
    expect(store.consume(token.token)).toMatchObject({ vaultId: "vault-u123" });
    expect(store.consume(token.token)).toBeUndefined();
    expect(store.peek(token.token)).toBeUndefined();
  });

  test("creating a new token invalidates previous tokens for the same user", () => {
    const store = new InMemoryLinkTokenStore();
    const first = store.create("slack", "U123", "D123", "vault-u123", "github");
    const second = store.create("slack", "U123", "D123", "vault-u123", "github");

    expect(store.peek(first.token)).toBeUndefined();
    expect(store.peek(second.token)).toBeDefined();
  });

  test("expired tokens cannot be consumed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const store = new InMemoryLinkTokenStore();
    const token = store.create("discord", "U123", "D123", "vault-u123", "github");

    vi.setSystemTime(new Date("2026-01-01T00:16:00Z"));
    expect(store.consume(token.token)).toBeUndefined();
  });
});
