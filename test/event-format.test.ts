import { describe, expect, test } from "vitest";
import { buildEventPayload, parseEventPayload } from "../src/harness/event-format.js";

describe("event-format round-trip", () => {
  test("build → serialize → parse is identity for every event type", () => {
    const payloads = [
      buildEventPayload({
        type: "immediate",
        platform: "slack",
        conversationId: "C123",
        conversationKind: "shared",
        userId: "U1",
        text: "check inbox",
      }),
      buildEventPayload({
        type: "one-shot",
        conversationId: "D456",
        text: "remind me",
        at: "2027-01-01T09:00:00+08:00",
      }),
      buildEventPayload({
        type: "periodic",
        platform: "telegram",
        conversationId: "789",
        text: "daily sweep",
        schedule: "0 9 * * *",
        timezone: "Asia/Taipei",
      }),
    ];

    for (const payload of payloads) {
      expect(parseEventPayload(JSON.stringify(payload), "roundtrip.json")).toEqual(payload);
    }
  });

  test("parse honors the legacy channelId alias", () => {
    const parsed = parseEventPayload(
      JSON.stringify({ type: "immediate", channelId: "D123", text: "hi" }),
      "legacy.json",
    );
    expect(parsed.conversationId).toBe("D123");
    expect("channelId" in parsed).toBe(false);
  });

  test("parse enforces per-type required fields", () => {
    expect(() =>
      parseEventPayload(
        JSON.stringify({ type: "one-shot", conversationId: "C1", text: "t" }),
        "f.json",
      ),
    ).toThrow(/Missing 'at' field for one-shot event in f\.json/);
    expect(() =>
      parseEventPayload(
        JSON.stringify({ type: "periodic", conversationId: "C1", text: "t" }),
        "f.json",
      ),
    ).toThrow(/Missing 'schedule' field for periodic event in f\.json/);
    expect(() =>
      parseEventPayload(
        JSON.stringify({
          type: "periodic",
          conversationId: "C1",
          text: "t",
          schedule: "0 9 * * *",
        }),
        "f.json",
      ),
    ).toThrow(/Missing 'timezone' field for periodic event in f\.json/);
    expect(() => parseEventPayload(JSON.stringify({ type: "immediate" }), "f.json")).toThrow(
      /Missing required fields \(type, conversationId, text\) in f\.json/,
    );
  });

  test("build enforces per-type required fields and at validity", () => {
    expect(() => buildEventPayload({ type: "one-shot", conversationId: "C1", text: "t" })).toThrow(
      "`at` is required for one-shot events",
    );
    expect(() =>
      buildEventPayload({ type: "one-shot", conversationId: "C1", text: "t", at: "not-a-date" }),
    ).toThrow("`at` must be a valid ISO 8601 timestamp with UTC offset");
    expect(() => buildEventPayload({ type: "periodic", conversationId: "C1", text: "t" })).toThrow(
      "`schedule` is required for periodic events",
    );
    expect(() =>
      buildEventPayload({
        type: "periodic",
        conversationId: "C1",
        text: "t",
        schedule: "0 9 * * *",
      }),
    ).toThrow("`timezone` is required for periodic events");
  });
});
