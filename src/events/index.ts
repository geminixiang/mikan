export type EventPayload = EventFilePayload;

export interface EventStore {
  write(filename: string, payload: EventFilePayload): Promise<{ path: string; size: number }>;
  /**
   * List all event files. Entries whose JSON cannot be parsed or fail format
   * validation are kept with a `null` payload so consumers (e.g. the admin
   * portal) can still surface and delete them; files that disappear
   * mid-listing are skipped.
   */
  list(): Promise<
    Array<{ filename: string; payload: EventFilePayload | null; size: number; mtimeMs: number }>
  >;
  read(
    filename: string,
  ): Promise<{ filename: string; payload: EventFilePayload; size: number; mtimeMs: number }>;
  update(filename: string, payload: EventFilePayload): Promise<{ path: string; size: number }>;
  delete(filename: string): Promise<{ deleted: boolean }>;
}

export type EventConversationKind = "direct" | "shared";

export type EventType = "immediate" | "one-shot" | "periodic";

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

/** Wire shape of one event file. */
export type EventFilePayload = ImmediateEventPayload | OneShotEventPayload | PeriodicEventPayload;

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

// Resolved runtime shapes: the watcher fills in the platform default and
// infers the conversation kind before an event reaches a bot.
interface ResolvedEventFields {
  platform: string;
  conversationKind: EventConversationKind;
}

export type ImmediateEvent = ImmediateEventPayload & ResolvedEventFields;
export type OneShotEvent = OneShotEventPayload & ResolvedEventFields;
export type PeriodicEvent = PeriodicEventPayload & ResolvedEventFields;
export type MikanEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export interface PeriodicEventInfo {
  filename: string;
  platform: string;
  conversationId: string;
  conversationKind: EventConversationKind;
  text: string;
  schedule: string;
  timezone: string;
  nextRun: string | null;
}

import { type Static, Type } from "@sinclair/typebox";
import { parseJsonSchemaValue } from "../file-guards.js";

/**
 * Single home for the scheduled-event file format (`events/*.json`, the
 * workspace scheduling bus). Every reader and writer — the EventsWatcher
 * scheduler and the agent `event` tool — must go
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
/**
 * Validate an untrusted event filename: a bare `*.json` basename with no
 * path traversal. Every surface that touches the events bus by filename
 * (the event tool's store, the admin portal's file endpoints) validates
 * through this single rule.
 */
export function validateEventFilename(filename: string): string {
  const trimmed = filename.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    !trimmed.endsWith(".json")
  ) {
    throw new Error("Invalid event filename");
  }
  return trimmed;
}

function isValidIsoTimestampWithOffset(value: string): boolean {
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
  // `channelId` is the legacy alias; parsed payloads expose only the
  // canonical `conversationId` field.
  const conversationId =
    typeof data.conversationId === "string"
      ? data.conversationId
      : typeof data.channelId === "string"
        ? data.channelId
        : undefined;
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

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateFile } from "../file-guards.js";

export class HostEventStore implements EventStore {
  constructor(private readonly eventsDir: string) {}

  static fromWorkspaceDir(workspaceDir: string): HostEventStore {
    return new HostEventStore(join(workspaceDir, "events"));
  }

  async write(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    return this.writePayload(filename, payload);
  }

  async list(): Promise<
    Array<{ filename: string; payload: EventPayload | null; size: number; mtimeMs: number }>
  > {
    await mkdir(this.eventsDir, { recursive: true });
    const entries = await readdir(this.eventsDir, { withFileTypes: true });
    const events = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return await this.read(entry.name);
          } catch {
            // Keep unparseable files visible (payload: null) so consumers can
            // surface and delete them; skip files that vanished mid-listing.
            try {
              const fileStat = await stat(join(this.eventsDir, entry.name));
              return {
                filename: entry.name,
                payload: null,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
              };
            } catch {
              return null;
            }
          }
        }),
    );
    return events
      .filter((event) => event !== null)
      .toSorted((a, b) => a.filename.localeCompare(b.filename));
  }

  async read(
    filename: string,
  ): Promise<{ filename: string; payload: EventPayload; size: number; mtimeMs: number }> {
    const safeFilename = validateEventFilename(filename);
    const filePath = join(this.eventsDir, safeFilename);
    const [raw, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    // Validation (shape, per-type fields, channelId alias) is owned by the
    // scheduled-event parser above; files that fail it surface as payload:null in
    // list() and as errors here.
    const payload = parseEventPayload(raw, safeFilename);
    return {
      filename: safeFilename,
      payload,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  }

  async update(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    return this.writePayload(filename, payload, true);
  }

  async delete(filename: string): Promise<{ deleted: boolean }> {
    const safeFilename = validateEventFilename(filename);
    await rm(join(this.eventsDir, safeFilename), { force: true });
    return { deleted: true };
  }

  private async writePayload(
    filename: string,
    payload: EventPayload,
    requireExisting = false,
  ): Promise<{ path: string; size: number }> {
    await mkdir(this.eventsDir, { recursive: true });
    const safeFilename = validateEventFilename(filename);
    const filePath = join(this.eventsDir, safeFilename);
    if (requireExisting) {
      await stat(filePath);
    }
    atomicWritePrivateFile(filePath, JSON.stringify(payload) + "\n");
    const fileStat = await stat(filePath);
    return { path: filePath, size: fileStat.size };
  }
}
