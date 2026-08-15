import { describe, expect, test, vi } from "vitest";
import { HarnessEventJournal } from "../web/harness/journal.js";

const event = {
  kind: "diagnostic" as const,
  officeKey: "office",
  sessionId: "session",
  runId: "run",
  text: "working",
  tone: "muted" as const,
};

describe("HarnessEventJournal", () => {
  test("replays and then streams one principal's ordered events", () => {
    const journal = new HarnessEventJournal();
    const cursor = journal.cursor("github:1");
    journal.publish("github:1", event);
    journal.publish("github:2", event);
    const listener = vi.fn();

    const subscription = journal.subscribe("github:1", cursor, listener);
    expect(subscription.kind).toBe("subscribed");
    expect(listener.mock.calls.map(([envelope]) => envelope.cursor.sequence)).toEqual([1]);

    journal.publish("github:1", { ...event, text: "done" });
    expect(listener.mock.calls.map(([envelope]) => envelope.cursor.sequence)).toEqual([1, 2]);
    if (subscription.kind === "subscribed") subscription.dispose();
    journal.publish("github:1", { ...event, text: "ignored" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("isolates a failing subscriber from publishers and other subscribers", () => {
    const journal = new HarnessEventJournal();
    const cursor = journal.cursor("github:1");
    journal.subscribe("github:1", cursor, () => {
      throw new Error("disconnected observer");
    });
    const healthy = vi.fn();
    journal.subscribe("github:1", cursor, healthy);

    expect(() => journal.publish("github:1", event)).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    journal.publish("github:1", event);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  test("requests a reset for a foreign epoch or an expired replay cursor", () => {
    const journal = new HarnessEventJournal(2);
    const initial = journal.cursor("github:1");
    journal.publish("github:1", event);
    journal.publish("github:1", event);
    journal.publish("github:1", event);

    expect(journal.subscribe("github:1", initial, vi.fn()).kind).toBe("reset");
    expect(
      journal.subscribe("github:1", { epoch: "previous-process", sequence: 3 }, vi.fn()).kind,
    ).toBe("reset");
  });
});
