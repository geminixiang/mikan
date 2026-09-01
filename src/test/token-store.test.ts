import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryAdminTokenStore } from "../web/admin/portal.js";
import { InMemoryLinkTokenStore } from "../web/login/portal.js";
import { InMemorySessionViewTokenStore } from "../web/session-view/portal.js";

function makeStore() {
  const store = new InMemoryAdminTokenStore();
  const create = () =>
    store.create({ platform: "slack", platformUserId: "U1", conversationId: "D1" });
  return { store, create };
}

// ── InMemoryTokenStore base behaviour ─────────────────────────────────────────
// Tested through InMemoryAdminTokenStore (simplest create signature).

describe("InMemoryTokenStore base", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── peek ──────────────────────────────────────────────────────────────────

  test("peek returns the token before expiry", () => {
    const { store, create } = makeStore();
    const t = create();
    expect(store.peek(t.token)).toMatchObject({ platformUserId: "U1" });
  });

  test("peek returns undefined for unknown token", () => {
    const { store } = makeStore();
    expect(store.peek("nonexistent")).toBeUndefined();
  });

  test("peek returns undefined after expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { store, create } = makeStore();
    const t = create();

    // AdminToken TTL is 30 min; advance past it
    vi.setSystemTime(new Date("2026-01-01T00:31:00Z"));
    expect(store.peek(t.token)).toBeUndefined();
  });

  // ── consume ───────────────────────────────────────────────────────────────

  test("consume returns the token and removes it", () => {
    const { store, create } = makeStore();
    const t = create();
    expect(store.consume(t.token)).toMatchObject({ conversationId: "D1" });
    expect(store.consume(t.token)).toBeUndefined();
    expect(store.peek(t.token)).toBeUndefined();
  });

  test("consume returns undefined for unknown token", () => {
    const { store } = makeStore();
    expect(store.consume("nonexistent")).toBeUndefined();
  });

  test("consume returns undefined for expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { store, create } = makeStore();
    const t = create();

    vi.setSystemTime(new Date("2026-01-01T00:31:00Z"));
    expect(store.consume(t.token)).toBeUndefined();
  });

  // ── purge ─────────────────────────────────────────────────────────────────

  test("purge removes expired tokens", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { store, create } = makeStore();
    const expired = create();

    vi.setSystemTime(new Date("2026-01-01T00:31:00Z"));
    // Create a fresh token at the new time
    const fresh = store.create({ platform: "slack", platformUserId: "U2", conversationId: "D2" });

    store.purge();

    expect(store.peek(expired.token)).toBeUndefined();
    expect(store.peek(fresh.token)).toBeDefined();
  });

  test("purge on empty store does not throw", () => {
    const { store } = makeStore();
    expect(() => store.purge()).not.toThrow();
  });
});

// ── Subclass-specific behaviour ───────────────────────────────────────────────

describe("InMemoryAdminTokenStore", () => {
  afterEach(() => vi.useRealTimers());

  test("create invalidates existing token for same platform user", () => {
    const store = new InMemoryAdminTokenStore();
    const first = store.create({ platform: "slack", platformUserId: "U1", conversationId: "D1" });
    const second = store.create({ platform: "slack", platformUserId: "U1", conversationId: "D1" });

    expect(store.peek(first.token)).toBeUndefined();
    expect(store.peek(second.token)).toBeDefined();
  });

  test("tokens for different users are independent", () => {
    const store = new InMemoryAdminTokenStore();
    const a = store.create({ platform: "slack", platformUserId: "U1", conversationId: "D1" });
    const b = store.create({ platform: "slack", platformUserId: "U2", conversationId: "D2" });

    expect(store.peek(a.token)).toBeDefined();
    expect(store.peek(b.token)).toBeDefined();
  });
});

describe("InMemoryLinkTokenStore", () => {
  afterEach(() => vi.useRealTimers());

  test("create invalidates existing token for same platform user", () => {
    const store = new InMemoryLinkTokenStore();
    const first = store.create("slack", "U1", "D1", "vault1", "github");
    const second = store.create("slack", "U1", "D1", "vault1", "github");

    expect(store.peek(first.token)).toBeUndefined();
    expect(store.peek(second.token)).toBeDefined();
  });

  test("consume is one-shot", () => {
    const store = new InMemoryLinkTokenStore();
    const t = store.create("slack", "U1", "D1", "vault1", "");
    expect(store.consume(t.token)).toMatchObject({ vaultId: "vault1" });
    expect(store.consume(t.token)).toBeUndefined();
  });

  test("expired token cannot be consumed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemoryLinkTokenStore();
    const t = store.create("slack", "U1", "D1", "vault1", "");

    vi.setSystemTime(new Date("2026-01-01T00:16:00Z")); // TTL is 15 min
    expect(store.consume(t.token)).toBeUndefined();
  });
});

describe("InMemorySessionViewTokenStore", () => {
  afterEach(() => vi.useRealTimers());

  test("create stores token and peek returns it", () => {
    const store = new InMemorySessionViewTokenStore();
    const t = store.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D1",
      sessionKey: "D1",
      sessionFile: "/path/session.jsonl",
    });
    expect(store.peek(t.token)).toMatchObject({ sessionFile: "/path/session.jsonl" });
  });

  test("multiple tokens coexist (no dedup on create)", () => {
    const store = new InMemorySessionViewTokenStore();
    const a = store.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D1",
      sessionKey: "D1",
      sessionFile: "/a.jsonl",
    });
    const b = store.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D1",
      sessionKey: "D1",
      sessionFile: "/b.jsonl",
    });

    // SessionViewTokenStore intentionally does NOT dedup on create
    expect(store.peek(a.token)).toBeDefined();
    expect(store.peek(b.token)).toBeDefined();
  });

  test("expired token is not returned by peek", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new InMemorySessionViewTokenStore();
    const t = store.create({
      platform: "slack",
      platformUserId: "U1",
      conversationId: "D1",
      sessionKey: "D1",
      sessionFile: "/session.jsonl",
    });

    vi.setSystemTime(new Date("2026-01-02T01:00:00Z")); // TTL is 24 h
    expect(store.peek(t.token)).toBeUndefined();
  });
});
