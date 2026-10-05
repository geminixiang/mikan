import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { isRecord } from "../unknown-values.js";

interface V3EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export type V3Entry = V3EntryBase &
  (
    | { type: "message"; message: { role: unknown } }
    | { type: "thinking_level_change"; thinkingLevel: string }
    | { type: "model_change"; provider: string; modelId: string }
    | { type: "compaction"; summary: string; firstKeptEntryId?: string; tokensBefore: number }
    | { type: "branch_summary"; fromId: string; summary: string }
    | { type: "custom"; customType: string; data?: unknown }
    | {
        type: "custom_message";
        customType: string;
        content: string | (TextContent | ImageContent)[];
        display: boolean;
      }
    | { type: "label"; targetId: string; label: string | undefined }
    | { type: "session_info"; name?: string }
  );

export interface V3Session {
  id: string;
  createdAt: number;
  name: string | undefined;
  entriesById: ReadonlyMap<string, V3Entry>;
  branch: V3Entry[];
}

const HEADER_PROBE_BYTES = 64 * 1024;

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf-8").split("\n", 1)[0] ?? "";
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

interface V3Header {
  type: "session";
  id: string;
  timestamp: string;
}

function isV3Header(value: unknown): value is V3Header {
  return (
    isRecord(value) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string"
  );
}

export function isV3SessionFile(path: string): boolean {
  try {
    return isV3Header(JSON.parse(readFirstLine(path)));
  } catch {
    return false;
  }
}

function isV3Entry(value: unknown): value is V3Entry {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    value.type !== "session" &&
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string"
  );
}

function parseLines(path: string): unknown[] {
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const records: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1 && index > 0) continue;
      throw new Error(`Invalid JSON on line ${index + 1} of ${path}`, { cause: error });
    }
  }
  return records;
}

function isFact(entry: V3Entry): boolean {
  return entry.type === "label" || entry.type === "session_info";
}

export function pathTo(entriesById: ReadonlyMap<string, V3Entry>, id: string | null): V3Entry[] {
  const path: V3Entry[] = [];
  let current = id === null ? undefined : entriesById.get(id);
  while (current) {
    path.push(current);
    current = current.parentId === null ? undefined : entriesById.get(current.parentId);
  }
  return path.toReversed();
}

export function epochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function readV3Session(path: string): V3Session {
  const [header, ...records] = parseLines(path);
  if (!isV3Header(header)) throw new Error(`Not a 0.5.3 session file: ${path}`);
  const entriesById = new Map<string, V3Entry>();
  for (const record of records) {
    if (isV3Entry(record)) entriesById.set(record.id, record);
  }
  const entries = [...entriesById.values()];
  const name = entries.findLast((entry) => entry.type === "session_info")?.name?.trim();
  return {
    id: header.id,
    createdAt: epochMillis(header.timestamp),
    name: name || undefined,
    entriesById,
    branch: pathTo(entriesById, entries.at(-1)?.id ?? null).filter((entry) => !isFact(entry)),
  };
}
