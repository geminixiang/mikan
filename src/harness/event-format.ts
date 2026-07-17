import { Type, type Static } from "@sinclair/typebox";
import { parseJsonSchemaValue } from "../utils/file-guards.js";

/**
 * Single home for the scheduled-event file format (`events/*.json`, the
 * workspace scheduling bus). Every reader and writer — the EventsWatcher
 * scheduler, the agent `event` tool, and the extension schedule API — must go
 * through this module: one schema, one payload union, one parser, one
 * builder. Per-type field rules (`at` for one-shot, `schedule` + `timezone`
 * for periodic) live here and nowhere else.
 */

export type EventConversationKind = "direct" | "shared";

export type EventType = "immediate" | "one-shot" | "periodic";

/** Typebox union for the `type` field, shared by the file schema and the event tool's parameters. */
export const EventTypeSchema = Type.Union([
  Type.Literal("immediate"),
  Type.Literal("one-shot"),
  Type.Literal("periodic"),
]);

interface EventPayloadBase {
  /** Target platform; may be omitted when only one platform is running. */
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  /** Self-contained task text; event runs do not inherit conversation history. */
  text: string;
}

export interface ImmediateEventPayload extends EventPayloadBase {
  type: "immediate";
}

export interface OneShotEventPayload extends EventPayloadBase {
  type: "one-shot";
  /** ISO 8601 timestamp with offset. */
  at: string;
}

export interface PeriodicEventPayload extends EventPayloadBase {
  type: "periodic";
  /** Cron expression (croner syntax). */
  schedule: string;
  /** IANA timezone, e.g. "Asia/Taipei". */
  timezone: string;
}

/**
 * Wire shape of one event file. Platform defaulting and conversation-kind
 * inference happen at read time (EventsWatcher), so both stay optional here.
 */
export type EventFilePayload = ImmediateEventPayload | OneShotEventPayload | PeriodicEventPayload;

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

export interface EventPayloadInput {
  type: EventType;
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  text: string;
  at?: string;
  schedule?: string;
  timezone?: string;
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
      if (Number.isNaN(new Date(input.at).getTime())) {
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
