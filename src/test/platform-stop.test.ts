import { describe, expect, test, vi } from "vitest";
import type { ConversationEvent } from "../adapter.js";
import { DiscordMessagingBot } from "../adapters/discord/bot.js";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import { TelegramMessagingBot } from "../adapters/telegram/bot.js";
import { MessagingEventQueue, MessagingIntakeTracker } from "../adapters/shared.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function uninitializedBot<T>(prototype: object, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(prototype) as object, fields) as T;
}

describe("MessagingIntakeTracker.close", () => {
  test("rejects new callbacks and waits for active intake", async () => {
    const gate = createDeferred();
    const calls: string[] = [];
    const intake = new MessagingIntakeTracker("test");
    const active = intake.run(async () => {
      calls.push("active");
      await gate.promise;
    });

    const closing = intake.close();
    await intake.run(() => {
      calls.push("late");
    });
    await Promise.resolve();
    expect(calls).toEqual(["active"]);

    gate.resolve();
    await Promise.all([active, closing]);
  });
});

describe("MessagingEventQueue.close", () => {
  test("rejects new work and waits for accepted work to drain", async () => {
    const gate = createDeferred();
    const calls: string[] = [];
    const queue = new MessagingEventQueue("test");
    queue.enqueue(async () => {
      calls.push("first");
      await gate.promise;
    });
    queue.enqueue(async () => {
      calls.push("second");
    });

    const closing = queue.close();
    queue.enqueue(async () => {
      calls.push("late");
    });
    await Promise.resolve();
    expect(calls).toEqual(["first"]);

    gate.resolve();
    await closing;
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("platform stop intake", () => {
  test("rejects scheduled events after every adapter is stopped", () => {
    const event = {
      conversationId: "C1",
      text: "late event",
    } as ConversationEvent;
    const bots = [
      uninitializedBot<SlackMessagingBot>(SlackMessagingBot.prototype, { stopped: true }),
      uninitializedBot<DiscordMessagingBot>(DiscordMessagingBot.prototype, { stopped: true }),
      uninitializedBot<TelegramMessagingBot>(TelegramMessagingBot.prototype, { stopped: true }),
      uninitializedBot<GithubMessagingBot>(GithubMessagingBot.prototype, { stopped: true }),
    ];

    for (const bot of bots) expect(bot.enqueueEvent(event)).toBe(false);
  });
  test("disconnects Slack Socket Mode", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const bot = uninitializedBot<SlackMessagingBot>(SlackMessagingBot.prototype, {
      socketClient: { disconnect },
      intake: new MessagingIntakeTracker("Slack"),
      queues: new Map(),
    });

    await bot.stop();

    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("destroys the Discord client", async () => {
    const destroy = vi.fn();
    const bot = uninitializedBot<DiscordMessagingBot>(DiscordMessagingBot.prototype, {
      client: { destroy },
      intake: new MessagingIntakeTracker("Discord"),
      queues: new Map(),
    });

    await bot.stop();

    expect(destroy).toHaveBeenCalledOnce();
  });

  test("stops Telegram polling", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const bot = uninitializedBot<TelegramMessagingBot>(TelegramMessagingBot.prototype, {
      client: { stop },
      intake: new MessagingIntakeTracker("Telegram"),
      queues: new Map(),
    });

    await bot.stop();

    expect(stop).toHaveBeenCalledOnce();
  });

  test("clears GitHub timers and waits for an active poll", async () => {
    const gate = createDeferred();
    const interval = setInterval(() => {}, 60_000);
    const requestTimer = setTimeout(() => {}, 60_000);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const bot = uninitializedBot<GithubMessagingBot>(GithubMessagingBot.prototype, {
      stopped: false,
      activePoll: gate.promise,
      pollPending: true,
      pollIntervalTimer: interval,
      requestPollTimer: requestTimer,
      queues: new Map(),
    });
    let settled = false;

    const stopping = bot.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(requestTimer);

    gate.resolve();
    await stopping;
    expect(settled).toBe(true);

    bot.requestPoll(0);
    expect(
      (bot as unknown as { requestPollTimer: NodeJS.Timeout | null }).requestPollTimer,
    ).toBeNull();

    clearIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });
});
