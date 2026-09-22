import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationEvent, MessagingBot } from "../types.js";
import { OfficeEventStore, officeEventsDir, parseEventPayload } from "../events/index.js";
import { EventScheduler, buildEventPrompt } from "../events/scheduler.js";
import { createOfficeAddress, createWorkspace, type Office } from "../office/index.js";
import { reportUserFacingError } from "../observability/index.js";

vi.mock("../observability/index.js", () => ({
  reportUserFacingError: vi.fn(),
}));

const mockReportUserFacingError = vi.mocked(reportUserFacingError);

function makeMessagingBot(platform: string) {
  const enqueueEvent = vi.fn<(event: ConversationEvent) => boolean>().mockReturnValue(true);
  const bot: MessagingBot = {
    start: async () => {},
    stop: async () => {},
    postMessage: async () => "1",
    updateMessage: async () => {},
    enqueueEvent,
    getMessagingInfo: () => ({ name: platform, formattingGuide: "", channels: [], users: [] }),
  };
  return { bot, enqueueEvent };
}

let dir: string;

beforeEach(() => {
  mockReportUserFacingError.mockClear();
  dir = mkdtempSync(join(tmpdir(), "mikan-events-test-"));
  mkdirSync(join(dir, "workspace"));
});

afterEach(() => {
  vi.useRealTimers();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  return createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") });
}

function office(platform: "slack" | "discord", conversationId: string): Office {
  const value = workspace().office(createOfficeAddress(platform, conversationId));
  value.ensure();
  return value;
}

describe("event payload parsing", () => {
  test("accepts legacy channelId field for backward compatibility", () => {
    const parsed = parseEventPayload(
      JSON.stringify({ type: "immediate", platform: "slack", channelId: "C-LEGACY", text: "x" }),
      "legacy.json",
    );
    expect(parsed).toEqual({
      type: "immediate",
      platform: "slack",
      conversationId: "C-LEGACY",
      text: "x",
    });
  });

  test("rejects event files with invalid field types", () => {
    expect(() =>
      parseEventPayload(
        JSON.stringify({ type: "immediate", conversationId: "C123", text: ["not", "a", "string"] }),
        "invalid-field.json",
      ),
    ).toThrow(/Malformed event file invalid-field\.json.*text.*Expected string/);
  });

  test("rejects event files whose top-level JSON is not an object", () => {
    expect(() => parseEventPayload("[]", "array.json")).toThrow(
      /Expected top-level JSON object in array\.json/,
    );
  });
});

describe("EventScheduler", () => {
  test("infers Discord DM conversation kind from DM-prefixed conversation IDs", async () => {
    const { bot, enqueueEvent } = makeMessagingBot("discord");
    const scheduler = new EventScheduler(workspace(), { discord: bot });
    scheduler.start();
    await new OfficeEventStore(office("discord", "DM123"), scheduler).create("dm.json", {
      type: "immediate",
      platform: "discord",
      conversationId: "DM123",
      text: "Check inbox",
    });
    expect(enqueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        address: expect.objectContaining({ conversationId: "DM123" }),
        conversationKind: "direct",
      }),
    );
    scheduler.stop();
  });

  test("removes records whose platform has no configured bot", async () => {
    const { bot } = makeMessagingBot("slack");
    const own = office("discord", "CH-42");
    mkdirSync(officeEventsDir(own), { recursive: true });
    writeFileSync(
      join(officeEventsDir(own), "orphan.json"),
      JSON.stringify({
        type: "immediate",
        platform: "discord",
        conversationId: "CH-42",
        text: "x",
      }),
    );
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    scheduler.start();
    expect(scheduler.scheduledCount()).toBe(0);
    expect(existsSync(join(officeEventsDir(own), "orphan.json"))).toBe(false);
    scheduler.stop();
  });

  test("deletes a one-shot event scheduled in the past without executing", async () => {
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    const own = office("slack", "D1");
    mkdirSync(officeEventsDir(own), { recursive: true });
    const path = join(officeEventsDir(own), "past.json");
    writeFileSync(
      path,
      JSON.stringify({
        type: "one-shot",
        platform: "slack",
        conversationId: "D1",
        text: "too late",
        at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    scheduler.start();
    expect(scheduler.scheduledCount()).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  test("stop cancels every pending timer and cron", async () => {
    vi.useFakeTimers();
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    scheduler.start();
    const store = new OfficeEventStore(office("slack", "D1"), scheduler);
    await store.create("later.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      text: "later",
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.create("daily.json", {
      type: "periodic",
      platform: "slack",
      conversationId: "D1",
      text: "standup",
      schedule: "* * * * *",
      timezone: "UTC",
    });
    expect(scheduler.scheduledCount()).toBe(2);
    scheduler.stop();
    expect(scheduler.scheduledCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  test("deletes a periodic event with an invalid cron schedule", async () => {
    const { bot } = makeMessagingBot("slack");
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    scheduler.start();
    const store = new OfficeEventStore(office("slack", "C1"), scheduler);
    await store.create("broken.json", {
      type: "periodic",
      platform: "slack",
      conversationId: "C1",
      text: "oops",
      schedule: "not a cron",
      timezone: "UTC",
    });
    expect(scheduler.scheduledCount()).toBe(0);
    expect(await store.list()).toEqual([]);
    scheduler.stop();
  });

  test("delivers an immediate event as a mention with the recorded user", async () => {
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    scheduler.start();
    const store = new OfficeEventStore(office("slack", "C1"), scheduler);
    await store.create("deploy-reminder.json", {
      type: "immediate",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      userId: "U123",
      text: "Deploy in 10 minutes",
    });
    expect(enqueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { platform: "slack", conversationId: "C1" },
        type: "mention",
        conversationKind: "shared",
        user: "U123",
        ts: "event:deploy-reminder",
        text: buildEventPrompt({
          type: "immediate",
          platform: "slack",
          conversationId: "C1",
          conversationKind: "shared",
          text: "Deploy in 10 minutes",
        }),
      }),
    );
    expect(await store.list()).toEqual([]);
    scheduler.stop();
  });

  test("reports a delivery failure and drops a one-shot when the queue is full", async () => {
    vi.useFakeTimers();
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    enqueueEvent.mockReturnValue(false);
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    scheduler.start();
    const store = new OfficeEventStore(office("slack", "D1"), scheduler);
    await store.create("full.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      text: "dropped",
      at: new Date(Date.now() + 1_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mockReportUserFacingError).toHaveBeenCalledTimes(1);
    expect(mockReportUserFacingError.mock.calls[0]![1].context).toMatchObject({
      failure: "queue_full",
      filename: "full.json",
    });
    expect(await store.list()).toEqual([]);
    scheduler.stop();
  });

  test("keeps periodic events on disk when the queue is full", async () => {
    vi.useFakeTimers();
    const { bot, enqueueEvent } = makeMessagingBot("slack");
    enqueueEvent.mockReturnValue(false);
    const scheduler = new EventScheduler(workspace(), { slack: bot });
    scheduler.start();
    const store = new OfficeEventStore(office("slack", "C1"), scheduler);
    await store.create("periodic-full.json", {
      type: "periodic",
      platform: "slack",
      conversationId: "C1",
      text: "recurring",
      schedule: "* * * * *",
      timezone: "UTC",
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockReportUserFacingError).toHaveBeenCalled();
    expect((await store.list()).map((event) => event.filename)).toEqual(["periodic-full.json"]);
    scheduler.stop();
  });
});

describe("event prompt building", () => {
  test("builds a reminder prompt for one-shot events", () => {
    const prompt = buildEventPrompt({
      type: "one-shot",
      platform: "slack",
      conversationId: "D1",
      conversationKind: "direct",
      text: "drink water",
      at: "2099-01-01T00:00:00Z",
    });
    expect(prompt).toContain("Reminder: drink water");
    expect(prompt).toContain("Do not greet");
  });

  test("builds a recurring-task prompt with a silent-reply hint for periodic events", () => {
    const prompt = buildEventPrompt({
      type: "periodic",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      text: "check CI",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });
    expect(prompt).toContain("Task: check CI");
    expect(prompt).toContain("[SILENT]");
  });

  test("builds an event prompt for immediate events", () => {
    const prompt = buildEventPrompt({
      type: "immediate",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      text: "deploy finished",
    });
    expect(prompt).toContain("Event: deploy finished");
  });
});
