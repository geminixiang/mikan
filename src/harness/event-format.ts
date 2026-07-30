import { Type, type Static } from "@sinclair/typebox";
import { parseJsonSchemaValue } from "../utils/file-guards.js";
import type { EventFilePayload, EventPayloadInput } from "./types.js";

export type {
  EventConversationKind,
  EventFilePayload,
  EventPayloadInput,
  EventType,
  ImmediateEventPayload,
  OneShotEventPayload,
  PeriodicEventPayload,
} from "./types.js";

/**
 * Single home for the scheduled-event file format (`events/*.json`, the
 * workspace scheduling bus). Every reader and writer — the EventsWatcher
 * scheduler, the agent `event` tool, and the extension schedule API — must go
 * through this module: one schema, one payload union, one parser, one
 * builder. Per-type field rules (`at` for one-shot, `schedule` + `timezone`
 * for periodic) live here and nowhere else.
 */

/** Typebox union for the `type` field, shared by the file schema and the event tool's parameters. */
export const EventTypeSchema = Type.Union([
  Type.Literal("immediate"),
  Type.Literal("one-shot"),
  Type.Literal("periodic"),
]);

/**
 * Lenient file-reading schema: every field optional so shape problems surface
 * as the specific missing-field messages below rather than typebox noise.
 * `channelId` is the legacy alias for `conversationId`.
 */
const EventFileSchema = Type.Object({
  type: Type.Optional(EventTypeSchema),
  platform: Type.Optional(Type.String()),
  conversationId: Type.Optional(Type.String()),
  channelId: Type.Optional(Type.String()),
  conversationKind: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("shared")])),
  userId: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
});

type EventFileData = Static<typeof EventFileSchema>;

const ISO_TIMESTAMP_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** True for a complete ISO 8601 timestamp that carries an explicit UTC offset. */
export function isValidIsoTimestampWithOffset(value: string): boolean {
  const match = ISO_TIMESTAMP_WITH_OFFSET.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 23 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * Resolve an event file's conversation id, honoring the legacy `channelId`
 * alias. Alias knowledge is private to the format module: consumers always
 * see `conversationId` on parsed payloads.
 */
function resolveEventConversationId(data: {
  conversationId?: unknown;
  channelId?: unknown;
}): string | undefined {
  if (typeof data.conversationId === "string") return data.conversationId;
  if (typeof data.channelId === "string") return data.channelId;
  return undefined;
}

/**
 * Parse and validate one event file's content into the canonical payload.
 * `filename` appears in error messages. Throws on malformed JSON, wrong
 * field types, and missing required fields (common and per-type).
 */
export function parseEventPayload(content: string, filename: string): EventFilePayload {
  const data: EventFileData = parseJsonSchemaValue(content, EventFileSchema, (detail) =>
    detail === "unexpected JSON shape"
      ? `Expected top-level JSON object in ${filename}`
      : `Malformed event file ${filename}: ${detail}`,
  );
  const conversationId = resolveEventConversationId(data);
  const { type, text } = data;

  if (!type || !conversationId || !text) {
    throw new Error(`Missing required fields (type, conversationId, text) in ${filename}`);
  }

  const base = {
    ...(data.platform !== undefined ? { platform: data.platform } : {}),
    conversationId,
    ...(data.conversationKind !== undefined ? { conversationKind: data.conversationKind } : {}),
    ...(data.userId !== undefined ? { userId: data.userId } : {}),
    text,
  };

  switch (type) {
    case "immediate":
      return { type, ...base };

    case "one-shot":
      if (typeof data.at !== "string" || data.at.length === 0) {
        throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
      }
      if (!isValidIsoTimestampWithOffset(data.at)) {
        throw new Error(
          `Invalid 'at' field for one-shot event in ${filename}: expected a valid ISO 8601 timestamp with UTC offset`,
        );
      }
      return { type, ...base, at: data.at };

    case "periodic":
      if (typeof data.schedule !== "string" || data.schedule.length === 0) {
        throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
      }
      if (typeof data.timezone !== "string" || data.timezone.length === 0) {
        throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
      }
      return { type, ...base, schedule: data.schedule, timezone: data.timezone };
  }
}

/**
 * Validate and assemble a new event payload for writing. Owns the per-type
 * field rules; write-side *policy* beyond the format (e.g. the event tool's
 * requirement that `at` lies in the future) stays with the writer.
 */
export function buildEventPayload(input: EventPayloadInput): EventFilePayload {
  const base = {
    ...(input.platform !== undefined ? { platform: input.platform } : {}),
    conversationId: input.conversationId,
    ...(input.conversationKind !== undefined ? { conversationKind: input.conversationKind } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    text: input.text,
  };

  switch (input.type) {
    case "immediate":
      return { type: "immediate", ...base };

    case "one-shot": {
      if (!input.at) {
        throw new Error("`at` is required for one-shot events");
      }
      if (!isValidIsoTimestampWithOffset(input.at)) {
        throw new Error("`at` must be a valid ISO 8601 timestamp with UTC offset");
      }
      return { type: "one-shot", ...base, at: input.at };
    }

    case "periodic":
      if (!input.schedule) {
        throw new Error("`schedule` is required for periodic events");
      }
      if (!input.timezone) {
        throw new Error("`timezone` is required for periodic events");
      }
      return { type: "periodic", ...base, schedule: input.schedule, timezone: input.timezone };
  }
}
