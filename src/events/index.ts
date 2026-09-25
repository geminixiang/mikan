import type { OfficeAddress, OfficeKey } from "../types.js";

export type EventPayload = EventFilePayload;

export interface EventRecord {
  filename: string;
  payload: EventFilePayload;
  size: number;
  mtimeMs: number;
}

export interface EventStore {
  readonly address: OfficeAddress;
  create(filename: string, payload: EventFilePayload): Promise<{ path: string; size: number }>;
  list(): Promise<Array<Omit<EventRecord, "payload"> & { payload: EventFilePayload | null }>>;
  read(filename: string): Promise<EventRecord>;
  update(filename: string, payload: EventFilePayload): Promise<{ path: string; size: number }>;
  delete(filename: string): Promise<{ deleted: boolean }>;
}

export interface EventScheduleSink {
  scheduleRecord(address: OfficeAddress, record: EventRecord): void;
  cancelRecord(address: OfficeAddress, filename: string): void;
}

export type EventConversationKind = "direct" | "shared";

export type EventType = "immediate" | "one-shot" | "periodic";

interface EventPayloadBase {
  platform?: string;
  conversationId: string;
  conversationKind?: EventConversationKind;
  userId?: string;
  text: string;
}

export interface ImmediateEventPayload extends EventPayloadBase {
  type: "immediate";
}

export interface OneShotEventPayload extends EventPayloadBase {
  type: "one-shot";
  at: string;
}

export interface PeriodicEventPayload extends EventPayloadBase {
  type: "periodic";
  schedule: string;
  timezone: string;
}

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

interface ResolvedEventFields {
  platform: string;
  conversationKind: EventConversationKind;
}

export type MikanEvent =
  | (ImmediateEventPayload & ResolvedEventFields)
  | (OneShotEventPayload & ResolvedEventFields)
  | (PeriodicEventPayload & ResolvedEventFields);

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

export const EventTypeSchema = Type.Union([
  Type.Literal("immediate"),
  Type.Literal("one-shot"),
  Type.Literal("periodic"),
]);

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

export function parseEventPayload(content: string, filename: string): EventFilePayload {
  const data: EventFileData = parseJsonSchemaValue(content, EventFileSchema, (detail) =>
    detail === "unexpected JSON shape"
      ? `Expected top-level JSON object in ${filename}`
      : `Malformed event file ${filename}: ${detail}`,
  );
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
    platform: data.platform,
    conversationId,
    conversationKind: data.conversationKind,
    userId: data.userId,
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

export function buildEventPayload(input: EventPayloadInput): EventFilePayload {
  const base = {
    platform: input.platform,
    conversationId: input.conversationId,
    conversationKind: input.conversationKind,
    userId: input.userId,
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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateFile } from "../file-guards.js";
import type { Office, Workspace } from "../office/index.js";
import { createOfficeAddress, listRegisteredOffices, officeKey } from "../office/index.js";

export function officeEventsDir(office: Office): string {
  return join(office.stateDir, "events");
}

export class OfficeEventStore implements EventStore {
  readonly address: OfficeAddress;
  private readonly eventsDir: string;

  constructor(
    private readonly office: Office,
    private readonly scheduler?: EventScheduleSink,
  ) {
    this.address = office.address;
    this.eventsDir = officeEventsDir(office);
  }

  async create(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    const safeFilename = validateEventFilename(filename);
    this.assertOwnPayload(payload);
    const filePath = join(this.eventsDir, safeFilename);
    if (existsSync(filePath)) {
      throw new Error(`Event ${safeFilename} already exists`);
    }
    return this.writeRecord(safeFilename, payload);
  }

  async list(): Promise<Array<Omit<EventRecord, "payload"> & { payload: EventPayload | null }>> {
    if (!existsSync(this.eventsDir)) return [];
    const entries = await readdir(this.eventsDir, { withFileTypes: true });
    const events = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return await this.read(entry.name);
          } catch {
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

  async read(filename: string): Promise<EventRecord> {
    const safeFilename = validateEventFilename(filename);
    const filePath = join(this.eventsDir, safeFilename);
    if (!existsSync(filePath)) {
      throw new Error(`Event ${safeFilename} not found in the current office`);
    }
    const [raw, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    return {
      filename: safeFilename,
      payload: parseEventPayload(raw, safeFilename),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  }

  async update(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    const safeFilename = validateEventFilename(filename);
    this.assertOwnPayload(payload);
    if (!existsSync(join(this.eventsDir, safeFilename))) {
      throw new Error(`Event ${safeFilename} not found in the current office`);
    }
    return this.writeRecord(safeFilename, payload);
  }

  async delete(filename: string): Promise<{ deleted: boolean }> {
    const safeFilename = validateEventFilename(filename);
    const filePath = join(this.eventsDir, safeFilename);
    if (!existsSync(filePath)) {
      throw new Error(`Event ${safeFilename} not found in the current office`);
    }
    this.scheduler?.cancelRecord(this.address, safeFilename);
    await rm(filePath, { force: true });
    return { deleted: true };
  }

  private assertOwnPayload(payload: EventPayload): void {
    if (
      payload.platform !== this.address.platform ||
      payload.conversationId !== this.address.conversationId
    ) {
      throw new Error("Event payload must address the current office");
    }
  }

  private async writeRecord(
    safeFilename: string,
    payload: EventPayload,
  ): Promise<{ path: string; size: number }> {
    await mkdir(this.eventsDir, { recursive: true });
    const filePath = join(this.eventsDir, safeFilename);
    atomicWritePrivateFile(filePath, JSON.stringify(payload) + "\n");
    const fileStat = await stat(filePath);
    this.scheduler?.scheduleRecord(this.address, {
      filename: safeFilename,
      payload,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    });
    return { path: filePath, size: fileStat.size };
  }
}

export interface LegacyEventMigrationReport {
  migrated: { filename: string; key: OfficeKey }[];
  skipped: { filename: string; reason: string }[];
}

export function migrateLegacyWorkspaceEvents(workspace: Workspace): LegacyEventMigrationReport {
  const report: LegacyEventMigrationReport = { migrated: [], skipped: [] };
  const legacyDir = join(workspace.root, "events");
  if (!existsSync(legacyDir)) return report;
  const registered = new Set(
    listRegisteredOffices(workspace.stateDir).map((record) => officeKey(record)),
  );
  for (const filename of readdirSync(legacyDir).filter((name) => name.endsWith(".json"))) {
    const source = join(legacyDir, filename);
    if (!statSync(source).isFile()) continue;
    let payload: EventFilePayload;
    try {
      payload = parseEventPayload(readFileSync(source, "utf-8"), filename);
    } catch (error) {
      report.skipped.push({
        filename,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!payload.platform) {
      report.skipped.push({ filename, reason: "no platform; owner cannot be attributed" });
      continue;
    }
    let address: OfficeAddress;
    try {
      address = createOfficeAddress(
        payload.platform as OfficeAddress["platform"],
        payload.conversationId,
      );
    } catch (error) {
      report.skipped.push({
        filename,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const key = officeKey(address);
    if (!registered.has(key)) {
      report.skipped.push({ filename, reason: `office ${key} is not registered` });
      continue;
    }
    const office = workspace.office(address);
    const targetDir = officeEventsDir(office);
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, filename);
    if (existsSync(target)) {
      report.skipped.push({ filename, reason: `already exists in ${key}` });
      continue;
    }
    atomicWritePrivateFile(target, JSON.stringify(payload) + "\n");
    rmSync(source);
    report.migrated.push({ filename, key });
  }
  return report;
}
