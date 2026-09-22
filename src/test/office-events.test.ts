import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationEvent, MessagingBot } from "../types.js";
import { OfficeEventStore, migrateLegacyWorkspaceEvents } from "../events/index.js";
import { EventScheduler } from "../events/scheduler.js";
import { createEventTool } from "../harness/tools/event.js";
import { createOfficeAddress, createWorkspace, type Office } from "../office/index.js";

vi.mock("../observability/index.js", () => ({ reportUserFacingError: vi.fn() }));

let dir: string;
let stateDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-office-events-"));
  stateDir = join(dir, "state");
  mkdirSync(join(dir, "workspace"), { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  return createWorkspace({ root: join(dir, "workspace"), stateDir });
}

function office(platform: "slack" | "discord", conversationId: string): Office {
  const value = workspace().office(createOfficeAddress(platform, conversationId));
  value.ensure();
  return value;
}

function bot(): { bot: MessagingBot; enqueueEvent: ReturnType<typeof vi.fn> } {
  const enqueueEvent = vi.fn<(event: ConversationEvent) => boolean>().mockReturnValue(true);
  return {
    enqueueEvent,
    bot: {
      start: async () => {},
      stop: async () => {},
      postMessage: async () => "1",
      updateMessage: async () => {},
      enqueueEvent,
      getMessagingInfo: () => ({ name: "slack", formattingGuide: "", channels: [], users: [] }),
    },
  };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe("OfficeEventStore", () => {
  test("stores events under the office state dir, never in the workspace", async () => {
    const own = office("slack", "C1");
    const store = new OfficeEventStore(own);
    await store.create("reminder.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C1",
      text: "ship",
      at: future(),
    });
    expect(existsSync(join(own.stateDir, "events", "reminder.json"))).toBe(true);
    expect(existsSync(join(dir, "workspace", "events"))).toBe(false);
    expect((await store.list()).map((event) => event.filename)).toEqual(["reminder.json"]);
  });

  test("create refuses to overwrite an existing filename", async () => {
    const store = new OfficeEventStore(office("slack", "C1"));
    const payload = {
      type: "immediate" as const,
      platform: "slack",
      conversationId: "C1",
      text: "x",
    };
    await store.create("dup.json", payload);
    await expect(store.create("dup.json", payload)).rejects.toThrow(/already exists/);
  });

  test("one office cannot see or touch another office's events", async () => {
    const a = new OfficeEventStore(office("slack", "C1"));
    const b = new OfficeEventStore(office("slack", "C2"));
    await a.create("a.json", {
      type: "immediate",
      platform: "slack",
      conversationId: "C1",
      text: "a",
    });
    expect(await b.list()).toEqual([]);
    await expect(b.read("a.json")).rejects.toThrow(/not found/);
    await expect(b.delete("a.json")).rejects.toThrow(/not found/);
    await expect(
      b.update("a.json", { type: "immediate", platform: "slack", conversationId: "C2", text: "b" }),
    ).rejects.toThrow(/not found/);
    expect((await a.list()).map((event) => event.filename)).toEqual(["a.json"]);
  });

  test("rejects payloads addressed to another office", async () => {
    const store = new OfficeEventStore(office("slack", "C1"));
    await expect(
      store.create("x.json", {
        type: "immediate",
        platform: "slack",
        conversationId: "C2",
        text: "x",
      }),
    ).rejects.toThrow(/current office/);
    await expect(
      store.create("y.json", {
        type: "immediate",
        platform: "discord",
        conversationId: "C1",
        text: "y",
      }),
    ).rejects.toThrow(/current office/);
  });
});

const periodic = (conversationId: string) => ({
  type: "periodic" as const,
  platform: "slack",
  conversationId,
  text: "standup",
  schedule: "0 9 * * *",
  timezone: "Asia/Taipei",
});

describe("EventScheduler", () => {
  test("loads events of every registered office at start and delivers them", async () => {
    vi.useFakeTimers();
    const { bot: slack, enqueueEvent } = bot();
    const c1 = office("slack", "C1");
    const c2 = office("slack", "C2");
    const at = new Date(Date.now() + 60_000).toISOString();
    await new OfficeEventStore(c1).create("r.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      text: "one",
      at,
    });
    await new OfficeEventStore(c2).create("r.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C2",
      conversationKind: "shared",
      text: "two",
      at,
    });

    const scheduler = new EventScheduler(workspace(), { slack });
    scheduler.start();
    expect(scheduler.scheduledCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(enqueueEvent).toHaveBeenCalledTimes(2);
    const targets = enqueueEvent.mock.calls
      .map(([event]) => (event as ConversationEvent).address.conversationId)
      .toSorted();
    expect(targets).toEqual(["C1", "C2"]);
    expect(readdirSync(join(c1.stateDir, "events"))).toEqual([]);
    scheduler.stop();
  });

  test("store mutations schedule, reschedule, and cancel without a filesystem watcher", async () => {
    vi.useFakeTimers();
    const { bot: slack, enqueueEvent } = bot();
    const scheduler = new EventScheduler(workspace(), { slack });
    scheduler.start();
    const own = office("slack", "C1");
    const store = new OfficeEventStore(own, scheduler);

    await store.create("r.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C1",
      text: "first",
      at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(scheduler.scheduledCount()).toBe(1);

    await store.update("r.json", {
      type: "one-shot",
      platform: "slack",
      conversationId: "C1",
      text: "later",
      at: new Date(Date.now() + 120_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(enqueueEvent).not.toHaveBeenCalled();

    await store.delete("r.json");
    expect(scheduler.scheduledCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enqueueEvent).not.toHaveBeenCalled();
    scheduler.stop();
  });

  test("lists periodic events per office only", async () => {
    const { bot: slack } = bot();
    const scheduler = new EventScheduler(workspace(), { slack });
    scheduler.start();
    const c1 = office("slack", "C1");
    const c2 = office("slack", "C2");
    await new OfficeEventStore(c1, scheduler).create("s.json", periodic("C1"));
    await new OfficeEventStore(c2, scheduler).create("s.json", periodic("C2"));

    expect(scheduler.periodicEvents(c1.address).map((event) => event.conversationId)).toEqual([
      "C1",
    ]);
    expect(scheduler.periodicEvents(c1.address)[0]?.nextRun).toBeTruthy();
    scheduler.stop();
  });
});

describe("event tool over OfficeEventStore", () => {
  test("agent CRUD is confined to the current office", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const own = office("slack", "C1");
    const other = office("slack", "C2");
    await new OfficeEventStore(other).create("theirs.json", {
      type: "immediate",
      platform: "slack",
      conversationId: "C2",
      text: "theirs",
    });
    const { tool, setEventContext } = createEventTool(new OfficeEventStore(own));
    setEventContext({
      platform: "slack",
      conversationId: "C1",
      conversationKind: "shared",
      userId: "U1",
    });

    await tool.execute("c", { type: "immediate", text: "mine", filenamePrefix: "mine" });
    const listed = JSON.parse(
      (await tool.execute("l", { action: "list" })).content[0]!.text as string,
    );
    expect(listed.events.map((event: { filename: string }) => event.filename)).toEqual([
      "mine-1700000000000.json",
    ]);
    await expect(tool.execute("r", { action: "read", filename: "theirs.json" })).rejects.toThrow(
      /not found/,
    );
    await expect(tool.execute("d", { action: "delete", filename: "theirs.json" })).rejects.toThrow(
      /not found/,
    );
    expect(existsSync(join(other.stateDir, "events", "theirs.json"))).toBe(true);
  });
});

describe("migrateLegacyWorkspaceEvents", () => {
  test("moves attributable legacy files into office state and reports the rest", () => {
    const own = office("slack", "C1");
    const legacyDir = join(dir, "workspace", "events");
    mkdirSync(legacyDir);
    writeFileSync(
      join(legacyDir, "ok.json"),
      JSON.stringify({
        type: "periodic",
        platform: "slack",
        conversationId: "C1",
        text: "standup",
        schedule: "0 9 * * *",
        timezone: "Asia/Taipei",
      }),
    );
    writeFileSync(
      join(legacyDir, "no-platform.json"),
      JSON.stringify({ type: "immediate", conversationId: "C1", text: "x" }),
    );
    writeFileSync(
      join(legacyDir, "unknown.json"),
      JSON.stringify({ type: "immediate", platform: "slack", conversationId: "C9", text: "x" }),
    );
    writeFileSync(join(legacyDir, "broken.json"), "{");

    const report = migrateLegacyWorkspaceEvents(workspace());

    expect(report.migrated).toEqual([{ filename: "ok.json", key: own.key }]);
    expect(report.skipped.map((entry) => entry.filename).toSorted()).toEqual([
      "broken.json",
      "no-platform.json",
      "unknown.json",
    ]);
    expect(statSync(join(own.stateDir, "events", "ok.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(legacyDir, "ok.json"))).toBe(false);
    expect(existsSync(join(legacyDir, "unknown.json"))).toBe(true);
  });
});
