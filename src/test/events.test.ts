import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingBot, ConversationEvent } from "../adapter.js";
import { EventsWatcher } from "../events.js";
import { reportUserFacingError } from "../observability/sentry.js";

vi.mock("../observability/sentry.js", () => ({
  reportUserFacingError: vi.fn(),
}));

const mockReportUserFacingError = vi.mocked(reportUserFacingError);

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
    expect(enqueueDiscord).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { platform: "discord", conversationId: "CH-42" },
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
      }),
    );
  });
});

describe("EventsWatcher scheduling", () => {
  let tmpDir: string;
  let eventsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mikan-events-sched-${Date.now()}-${Math.random()}`);
    eventsDir = join(tmpDir, "events");
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("deletes a one-shot event scheduled in the past without executing", () => {
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const filename = "past.json";
    const filePath = join(eventsDir, filename);
    writeFileSync(filePath, "{}");

    watcher.handleOneShot(filename, {
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "too late",
      at: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(watcher.timers.has(filename)).toBe(false);
    expect(existsSync(filePath)).toBe(false);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  test("stores a timer for a one-shot event scheduled in the future", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const filename = "future.json";

    watcher.handleOneShot(filename, {
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "later",
      at: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(watcher.timers.has(filename)).toBe(true);
    watcher.stop();
    expect(watcher.timers.has(filename)).toBe(false);
  });

  test("schedules a periodic event and exposes it via getPeriodicEvents", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const filename = "daily.json";
    writeFileSync(
      join(eventsDir, filename),
      JSON.stringify({
        type: "periodic",
        platform: "slack",
        conversationId: "C1",
        conversationKind: "shared",
        text: "standup",
        schedule: "0 9 * * *",
        timezone: "UTC",
      }),
    );

    watcher.handlePeriodic(filename, {
      type: "periodic",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      text: "standup",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });

    expect(watcher.crons.has(filename)).toBe(true);

    const infos = watcher.getPeriodicEvents();
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({
      filename,
      platform: "slack",
      conversationId: "C1",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });
    expect(infos[0].nextRun).toEqual(expect.any(String));

    watcher.stop();
    expect(watcher.crons.has(filename)).toBe(false);
  });

  test("deletes a periodic event with an invalid cron schedule", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    const filename = "broken.json";
    const filePath = join(eventsDir, filename);
    writeFileSync(filePath, "{}");

    watcher.handlePeriodic(filename, {
      type: "periodic",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      text: "oops",
      schedule: "not a cron",
      timezone: "UTC",
    });

    expect(watcher.crons.has(filename)).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  test("deletes a stale immediate event created before startup", () => {
    const filename = "stale.json";
    const filePath = join(eventsDir, filename);
    writeFileSync(filePath, "{}");
    const staleTime = new Date(Date.now() - 1000);
    utimesSync(filePath, staleTime, staleTime);

    const { bot, enqueueEvent } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    watcher.handleImmediate(filename, {
      type: "immediate",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "old news",
    });

    expect(existsSync(filePath)).toBe(false);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  test("executes a fresh immediate event created after startup", () => {
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;
    // Pin startup before the file's mtime so the event reads as fresh regardless
    // of filesystem timestamp granularity.
    watcher.startTime = 0;

    const filename = "fresh.json";
    const filePath = join(eventsDir, filename);
    writeFileSync(filePath, "{}");

    watcher.handleImmediate(filename, {
      type: "immediate",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "breaking",
    });

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent.mock.calls[0]?.[0]).toMatchObject({
      ts: "event:fresh",
      origin: { kind: "scheduled-event", eventId: "fresh" },
    });
    // Immediate events are deleted after a successful enqueue.
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("EventsWatcher delivery failures", () => {
  let tmpDir: string;
  let eventsDir: string;

  beforeEach(() => {
    mockReportUserFacingError.mockClear();
    tmpDir = join(tmpdir(), `mikan-events-fail-${Date.now()}-${Math.random()}`);
    eventsDir = join(tmpDir, "events");
    mkdirSync(eventsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reports a delivery failure when no bot is configured for the platform", () => {
    const { bot } = makeMessagingBot("slack");
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    watcher.execute("orphan.json", {
      type: "immediate",
      platform: "discord",
      conversationId: "C1",
      conversationKind: "shared",
      text: "nobody home",
    });

    expect(mockReportUserFacingError).toHaveBeenCalledTimes(1);
    const [, options] = mockReportUserFacingError.mock.calls[0];
    expect(options).toMatchObject({
      domain: "events",
      surface: "event_delivery",
      platform: "discord",
      context: expect.objectContaining({ failure: "missing_bot", filename: "orphan.json" }),
    });
  });

  test("reports a delivery failure when the bot queue is full", () => {
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    enqueueEvent.mockReturnValue(false);
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    const filename = "full.json";
    const filePath = join(eventsDir, filename);
    writeFileSync(filePath, "{}");

    watcher.execute(filename, {
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "dropped",
      at: new Date().toISOString(),
    });

    expect(mockReportUserFacingError).toHaveBeenCalledTimes(1);
    const [, options] = mockReportUserFacingError.mock.calls[0];
    expect(options.context).toMatchObject({ failure: "queue_full", filename });
    // One-shot events are removed even when discarded.
    expect(existsSync(filePath)).toBe(false);
  });

  test("keeps periodic events on disk when the queue is full", () => {
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    enqueueEvent.mockReturnValue(false);
    const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

    const filename = "periodic-full.json";
    const filePath = join(eventsDir, filename);
    writeFileSync(filePath, "{}");

    watcher.execute(
      filename,
      {
        type: "periodic",
        platform: "slack",
        conversationId: "C1",
        conversationKind: "shared",
        text: "recurring",
        schedule: "0 9 * * *",
        timezone: "UTC",
      },
      false,
    );

    expect(mockReportUserFacingError).toHaveBeenCalledTimes(1);
    // Periodic events must survive a transient queue-full so the next tick can retry.
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("EventsWatcher prompt building", () => {
  const eventsDir = join(tmpdir(), "mikan-events-prompt");
  const { bot } = makeMessagingBot("slack");
  const watcher = new EventsWatcher(eventsDir, { slack: bot }) as any;

  test("builds a reminder prompt for one-shot events", () => {
    const prompt = watcher.buildEventPrompt({
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "call the dentist",
      at: new Date().toISOString(),
    });
    expect(prompt).toContain("Reminder: call the dentist");
    expect(prompt).toContain("deliver the following reminder");
  });

  test("builds a recurring-task prompt with a silent-reply hint for periodic events", () => {
    const prompt = watcher.buildEventPrompt({
      type: "periodic",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      text: "post the standup summary",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });
    expect(prompt).toContain("Task: post the standup summary");
    expect(prompt).toContain("[SILENT]");
  });

  test("builds an event prompt for immediate events", () => {
    const prompt = watcher.buildEventPrompt({
      type: "immediate",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "deploy finished",
    });
    expect(prompt).toContain("Event: deploy finished");
  });
});
