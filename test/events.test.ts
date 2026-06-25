import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingBot, ConversationEvent } from "../src/adapter.js";
import { EventsWatcher } from "../src/events.js";

function makeMessagingBot(platform: string) {
  const enqueueEvent = vi.fn<(event: ConversationEvent) => boolean>().mockReturnValue(true);

  const bot: MessagingBot = {
    start: async () => {},
    postMessage: async () => "1",
    updateMessage: async () => {},
    enqueueEvent,
    getMessagingInfo: () => ({
      name: platform,
      formattingGuide: "",
      channels: [],
      users: [],
    }),
  };

  return { bot, enqueueEvent };
}

describe("EventsWatcher platform routing", () => {
  let tmpDir: string;
  let eventsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mikan-events-test-${Date.now()}`);
    eventsDir = join(tmpDir, "events");
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("defaults platform when exactly one bot is configured", () => {
    const { bot } = makeMessagingBot("telegram");
    const watcher = new EventsWatcher(eventsDir, { telegram: bot }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({
        type: "immediate",
        conversationId: "123",
        text: "Check inbox",
      }),
      "single-platform.json",
    );

    expect(parsed).toEqual({
      type: "immediate",
      platform: "telegram",
      conversationId: "123",
      conversationKind: "direct",
      userId: undefined,
      text: "Check inbox",
    });
  });

  test("accepts legacy channelId field for backward compatibility", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({
        type: "immediate",
        channelId: "D123",
        text: "Check inbox",
      }),
      "legacy.json",
    );

    expect(parsed).toEqual({
      type: "immediate",
      platform: "slack",
      conversationId: "D123",
      conversationKind: "direct",
      userId: undefined,
      text: "Check inbox",
    });
  });

  test("infers Discord DM event conversation kind from DM-prefixed conversation IDs", () => {
    const { bot } = makeMessagingBot("discord");
    const watcher = new EventsWatcher(eventsDir, { discord: bot }) as any;

    const parsed = watcher.parseEvent(
      JSON.stringify({
        type: "immediate",
        conversationId: "DM123",
        text: "Check inbox",
      }),
      "discord-dm.json",
    );

    expect(parsed).toEqual({
      type: "immediate",
      platform: "discord",
      conversationId: "DM123",
      conversationKind: "direct",
      userId: undefined,
      text: "Check inbox",
    });
  });

  test("rejects ambiguous events when multiple platforms are configured", () => {
    const { bot: slackMessagingBot } = makeMessagingBot("slack");
    const { bot: telegramMessagingBot } = makeMessagingBot("telegram");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackMessagingBot,
      telegram: telegramMessagingBot,
    }) as any;

    expect(() =>
      watcher.parseEvent(
        JSON.stringify({
          type: "immediate",
          conversationId: "123",
          text: "Check inbox",
        }),
        "ambiguous.json",
      ),
    ).toThrow(/Missing required field 'platform'/);
  });

  test("rejects event files with invalid field types", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    expect(() =>
      watcher.parseEvent(
        JSON.stringify({
          type: "immediate",
          conversationId: "C123",
          text: ["not", "a", "string"],
        }),
        "invalid-field.json",
      ),
    ).toThrow(/Malformed event file invalid-field\.json.*text.*Expected string/);
  });

  test("rejects event files whose top-level JSON is not an object", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    expect(() => watcher.parseEvent("[]", "array.json")).toThrow(
      /Expected top-level JSON object in array\.json/,
    );
  });

  test("ignores transient missing-file signals so scheduled events stay active", async () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const filename = "reminder.json";
    const filePath = join(eventsDir, filename);

    writeFileSync(
      filePath,
      JSON.stringify({
        type: "one-shot",
        platform: "slack",
        conversationId: "D123",
        conversationKind: "direct",
        text: "wake up",
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    await watcher.handleFile(filename);
    expect(watcher.timers.has(filename)).toBe(true);

    watcher.sleep = vi.fn(async () => {
      if (!existsSync(filePath)) {
        writeFileSync(
          filePath,
          JSON.stringify({
            type: "one-shot",
            platform: "slack",
            conversationId: "D123",
            conversationKind: "direct",
            text: "wake up",
            at: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      }
    });

    rmSync(filePath, { force: true });
    await watcher.handleDelete(filename);

    expect(watcher.timers.has(filename)).toBe(true);
    expect(watcher.knownFiles.has(filename)).toBe(true);
  });

  test("keeps a scheduled one-shot timer even if the file truly disappears", async () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const filename = "reminder.json";
    const filePath = join(eventsDir, filename);

    writeFileSync(
      filePath,
      JSON.stringify({
        type: "one-shot",
        platform: "slack",
        conversationId: "D123",
        conversationKind: "direct",
        text: "wake up",
        at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    await watcher.handleFile(filename);
    expect(watcher.timers.has(filename)).toBe(true);

    rmSync(filePath, { force: true });
    await watcher.handleDelete(filename);

    expect(watcher.timers.has(filename)).toBe(true);
    expect(watcher.knownFiles.has(filename)).toBe(true);
  });

  test("routes synthetic events to the explicitly requested platform", () => {
    const { bot: slackMessagingBot, enqueueEvent: enqueueSlack } = makeMessagingBot("slack");
    const { bot: discordMessagingBot, enqueueEvent: enqueueDiscord } = makeMessagingBot("discord");
    const watcher = new EventsWatcher(eventsDir, {
      slack: slackMessagingBot,
      discord: discordMessagingBot,
    }) as any;

    watcher.execute("deploy-reminder.json", {
      type: "immediate",
      platform: "discord",
      conversationId: "CH-42",
      conversationKind: "shared",
      text: "Deploy in 10 minutes",
      userId: "U123",
    });

    expect(enqueueSlack).not.toHaveBeenCalled();
    expect(enqueueDiscord).toHaveBeenCalledTimes(1);
    expect(enqueueDiscord).toHaveBeenCalledWith({
      type: "mention",
      conversationId: "CH-42",
      conversationKind: "shared",
      user: "U123",
      text: [
        "Handle the following event/update in a concise, context-appropriate way.",
        "If it reads like a reminder or follow-up, deliver it directly without greeting or generic offers to help.",
        "",
        "Event: Deploy in 10 minutes",
      ].join("\n"),
      ts: "event:deploy-reminder",
    });
  });
});
