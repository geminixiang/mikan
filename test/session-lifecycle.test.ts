import { describe, expect, test, vi } from "vitest";
import { SessionLifecycle } from "../src/runtime/session-lifecycle.js";
import type { ConversationRuntimeState } from "../src/runtime/types.js";

function state(lastAccessedAt = 0): ConversationRuntimeState {
  return {
    running: false,
    runner: {
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConversationRuntimeState["runner"],
    stopRequested: false,
    lastAccessedAt,
    sessionFile: "/session.jsonl",
    startedAt: 0,
  };
}

describe("SessionLifecycle", () => {
  test("serializes runs by session key", async () => {
    const lifecycle = new SessionLifecycle();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = lifecycle.enqueue("C1", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = lifecycle.enqueue("C1", async () => order.push("second"));

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("clears idle conversation states and disposes runners through its interface", async () => {
    const lifecycle = new SessionLifecycle();
    const top = state();
    const thread = state();
    lifecycle.set("C1", top);
    lifecycle.set("C1:T1", thread);

    expect(lifecycle.clearConversation("C1")).toBe(true);
    expect(lifecycle.get("C1")).toBeUndefined();
    expect(top.runner.dispose).toHaveBeenCalledOnce();
    expect(thread.runner.dispose).toHaveBeenCalledOnce();
  });

  test("refuses to clear a conversation with a running state", () => {
    const lifecycle = new SessionLifecycle();
    const running = state();
    running.running = true;
    lifecycle.set("C1", running);

    expect(lifecycle.clearConversation("C1")).toBe(false);
    expect(lifecycle.get("C1")).toBe(running);
  });

  test("evicts expired and excess idle sessions but preserves running sessions", () => {
    const lifecycle = new SessionLifecycle({ maxSessions: 2, idleTimeoutMs: 10, now: () => 100 });
    const expired = state(80);
    const old = state(95);
    const recent = state(99);
    const running = state(0);
    running.running = true;
    lifecycle.set("C1", expired);
    lifecycle.set("C2", old);
    lifecycle.set("C3", recent);
    lifecycle.set("C4", running);

    lifecycle.evictIdle();
    expect(lifecycle.get("C1")).toBeUndefined();
    expect(lifecycle.get("C2")).toBeUndefined();
    expect(lifecycle.get("C3")).toBe(recent);
    expect(lifecycle.get("C4")).toBe(running);
  });
});
