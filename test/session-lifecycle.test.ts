import { describe, expect, test, vi } from "vitest";
import type { OfficeAddress } from "../src/adapter.js";
import { createOfficeAddress } from "../src/office-address.js";
import { SessionLifecycle } from "../src/runtime/session-lifecycle.js";
import type { ConversationRuntimeState } from "../src/runtime/types.js";

const slack = createOfficeAddress("slack", "C1");

function state(
  sessionKey: string,
  options: { address?: OfficeAddress; lastAccessedAt?: number } = {},
): ConversationRuntimeState {
  return {
    address: options.address ?? slack,
    sessionKey,
    running: false,
    runner: {
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConversationRuntimeState["runner"],
    stopRequested: false,
    lastAccessedAt: options.lastAccessedAt ?? 0,
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
    const first = lifecycle.enqueue(slack, "C1", async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = lifecycle.enqueue(slack, "C1", async () => order.push("second"));

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("clears idle conversation states and disposes runners through its interface", async () => {
    const lifecycle = new SessionLifecycle();
    const top = state("C1");
    const thread = state("C1:T1");
    lifecycle.set(top);
    lifecycle.set(thread);

    expect(lifecycle.clearConversation(slack)).toBe(true);
    expect(lifecycle.get(slack, "C1")).toBeUndefined();
    expect(top.runner.dispose).toHaveBeenCalledOnce();
    expect(thread.runner.dispose).toHaveBeenCalledOnce();
  });

  test("refuses to clear a conversation with a running state", () => {
    const lifecycle = new SessionLifecycle();
    const running = state("C1");
    running.running = true;
    lifecycle.set(running);

    expect(lifecycle.clearConversation(slack)).toBe(false);
    expect(lifecycle.get(slack, "C1")).toBe(running);
  });

  test("evicts expired and excess idle sessions but preserves running sessions", () => {
    const lifecycle = new SessionLifecycle({ maxSessions: 2, idleTimeoutMs: 10, now: () => 100 });
    const expired = state("C1", { lastAccessedAt: 80 });
    const old = state("C2", { lastAccessedAt: 95 });
    const recent = state("C3", { lastAccessedAt: 99 });
    const running = state("C4");
    running.running = true;
    for (const entry of [expired, old, recent, running]) lifecycle.set(entry);

    lifecycle.evictIdle();
    expect(lifecycle.get(slack, "C1")).toBeUndefined();
    expect(lifecycle.get(slack, "C2")).toBeUndefined();
    expect(lifecycle.get(slack, "C3")).toBe(recent);
    expect(lifecycle.get(slack, "C4")).toBe(running);
  });

  test("does not evict a session until its run settlement is cleared", () => {
    const lifecycle = new SessionLifecycle({ maxSessions: 1, idleTimeoutMs: 10, now: () => 100 });
    const settling = state("settling");
    settling.runSettlement = new Promise<void>(() => {});
    const idle = state("idle", { lastAccessedAt: 99 });
    lifecycle.set(settling);
    lifecycle.set(idle);

    lifecycle.evictIdle();
    expect(lifecycle.get(slack, "settling")).toBe(settling);
    expect(lifecycle.get(slack, "idle")).toBeUndefined();

    settling.runSettlement = undefined;
    lifecycle.evictIdle();
    expect(lifecycle.get(slack, "settling")).toBeUndefined();
  });

  describe("offices with the same raw conversation id stay separate", () => {
    const discord = createOfficeAddress("discord", "900100");
    const telegram = createOfficeAddress("telegram", "900100");

    test("identical session keys resolve to different runtime state", () => {
      const lifecycle = new SessionLifecycle();
      const discordState = state("900100", { address: discord });
      const telegramState = state("900100", { address: telegram });
      lifecycle.set(discordState);
      lifecycle.set(telegramState);

      expect(lifecycle.get(discord, "900100")).toBe(discordState);
      expect(lifecycle.get(telegram, "900100")).toBe(telegramState);
      expect(lifecycle.offices()).toHaveLength(2);
    });

    test("clearing one office leaves the other's runner alive", () => {
      const lifecycle = new SessionLifecycle();
      const discordState = state("900100", { address: discord });
      const telegramState = state("900100", { address: telegram });
      lifecycle.set(discordState);
      lifecycle.set(telegramState);

      expect(lifecycle.clearConversation(discord)).toBe(true);
      expect(lifecycle.get(discord, "900100")).toBeUndefined();
      expect(lifecycle.get(telegram, "900100")).toBe(telegramState);
      expect(discordState.runner.dispose).toHaveBeenCalledOnce();
      expect(telegramState.runner.dispose).not.toHaveBeenCalled();
    });

    test("a busy office does not block clearing the other", () => {
      const lifecycle = new SessionLifecycle();
      const busy = state("900100", { address: discord });
      busy.running = true;
      lifecycle.set(busy);
      lifecycle.set(state("900100", { address: telegram }));

      expect(lifecycle.clearConversation(discord)).toBe(false);
      expect(lifecycle.clearConversation(telegram)).toBe(true);
    });

    test("a raw conversation id resolves to every office behind it", () => {
      const lifecycle = new SessionLifecycle();
      lifecycle.set(state("900100", { address: discord }));
      lifecycle.set(state("900100", { address: telegram }));
      lifecycle.set(state("C1"));

      expect(lifecycle.officesForConversationId("900100")).toEqual(
        expect.arrayContaining([discord, telegram]),
      );
      expect(lifecycle.officesForConversationId("900100")).toHaveLength(2);
      expect(lifecycle.officesForConversationId("C1")).toEqual([slack]);
    });

    test("queues do not serialize across offices", async () => {
      const lifecycle = new SessionLifecycle();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));

      const blocked = lifecycle.enqueue(discord, "900100", async () => {
        order.push("discord:start");
        await gate;
        order.push("discord:end");
      });
      const other = lifecycle.enqueue(telegram, "900100", async () => order.push("telegram"));

      await other;
      expect(order).toEqual(["discord:start", "telegram"]);
      release();
      await blocked;
    });

    test("a maintenance barrier only holds its own office", async () => {
      const lifecycle = new SessionLifecycle();
      let releaseMaintenance!: () => void;
      const maintenanceGate = new Promise<void>((resolve) => (releaseMaintenance = resolve));
      const maintenance = lifecycle.runConversationMaintenance(discord, () => maintenanceGate);

      // Same raw id, different platform: this office is not under maintenance.
      const release = await lifecycle.acquireConversationWork(telegram);
      release();

      releaseMaintenance();
      await maintenance;
    });
  });
});
