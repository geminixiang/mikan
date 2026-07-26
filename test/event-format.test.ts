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

  test("one-shot timestamps require and preserve an explicit UTC designator", () => {
    const input = { type: "one-shot" as const, conversationId: "C1", text: "t" };

    expect(() => buildEventPayload({ ...input, at: "2027-01-01T09:00:00" })).toThrow(
      "`at` must be a valid ISO 8601 timestamp with UTC offset",
    );
    expect(buildEventPayload({ ...input, at: "2027-01-01T09:00:00Z" })).toMatchObject({
      type: "one-shot",
      at: "2027-01-01T09:00:00Z",
    });
    expect(buildEventPayload({ ...input, at: "2027-01-01T09:00:00+08:00" })).toMatchObject({
      type: "one-shot",
      at: "2027-01-01T09:00:00+08:00",
    });

    expect(() =>
      parseEventPayload(JSON.stringify({ ...input, at: "2027-01-01T09:00:00" }), "no-offset.json"),
    ).toThrow(/Invalid 'at' field for one-shot event in no-offset\.json/);
    expect(
      parseEventPayload(JSON.stringify({ ...input, at: "2027-01-01T09:00:00Z" }), "utc.json"),
    ).toMatchObject({ type: "one-shot", at: "2027-01-01T09:00:00Z" });
  });

  test("build and parse reject invalid calendar, time, and offset components", () => {
    const input = { type: "one-shot" as const, conversationId: "C1", text: "t" };
    const invalidTimestamps = [
      "2027-02-30T09:00:00Z",
      "2027-01-01T24:00:00Z",
      "2027-01-01T09:60:00Z",
      "2027-01-01T09:00:60Z",
      "2027-01-01T09:00:00+24:00",
      "2027-01-01T09:00:00+08:60",
    ];

    for (const at of invalidTimestamps) {
      expect(() => buildEventPayload({ ...input, at })).toThrow(
        "`at` must be a valid ISO 8601 timestamp with UTC offset",
      );
      expect(() => parseEventPayload(JSON.stringify({ ...input, at }), "invalid.json")).toThrow(
        /Invalid 'at' field for one-shot event in invalid\.json/,
      );
    }
  });

  test("build and parse accept a valid leap-day timestamp", () => {
    const payload = buildEventPayload({
      type: "one-shot",
      conversationId: "C1",
      text: "t",
      at: "2028-02-29T09:00:00.123+08:00",
    });

    expect(payload.at).toBe("2028-02-29T09:00:00.123+08:00");
    expect(parseEventPayload(JSON.stringify(payload), "leap-day.json")).toEqual(payload);
  });
});
