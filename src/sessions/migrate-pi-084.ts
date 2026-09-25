import { readFileSync } from "node:fs";
import type { AgentMessage, Entry, JsonValue } from "@earendil-works/pi-agent-core";
import { SessionStore } from "./session-store.js";
import { isRecord } from "../file-guards.js";
import {
  commitMigration,
  findSessionFiles,
  jsonValue,
  optionalAnnotations,
  V4FileWriter,
} from "./migrate-common.js";
import type { Pi084MigrationResult } from "./types.js";
export type { Pi084MigrationResult } from "./types.js";

interface Pi084Header {
  kind: "header";
  version: 4;
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  metadata?: Record<string, JsonValue>;
}

interface Pi084Mutations {
  entries: Entry[];
  branchTips: Map<string, string | null>;
  labels: Map<string, string>;
  records: JsonValue[];
  name?: string;
}

interface ParsedPi084Session extends Pi084Mutations {
  header: Pi084Header;
  metadata?: Record<string, JsonValue>;
}

function firstLine(filePath: string): string {
  return readFileSync(filePath, "utf8").split("\n", 1)[0]?.trim() ?? "";
}

function parseHeader(value: unknown, filePath: string): Pi084Header {
  if (
    !isRecord(value) ||
    value.kind !== "header" ||
    value.version !== 4 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.cwd !== "string"
  ) {
    throw new Error(`Invalid Pi 0.84 session header: ${filePath}`);
  }
  return value as unknown as Pi084Header;
}

function isCurrentHeader(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === "header" &&
    value.v === 4 &&
    typeof value.storageVersion === "number"
  );
}

export function isPi084SessionFile(filePath: string): boolean {
  try {
    const value: unknown = JSON.parse(firstLine(filePath));
    return isRecord(value) && value.kind === "header" && value.version === 4;
  } catch {
    return false;
  }
}

function convertEntry(record: Record<string, unknown>): Entry {
  const { kind: _kind, lane: _lane, ...raw } = record;
  const base = {
    id: String(raw.id),
    parentId: typeof raw.parentId === "string" ? raw.parentId : null,
    seq: Number(raw.seq),
    timestamp: Number(raw.timestamp),
  };
  switch (raw.type) {
    case "message":
      return { ...base, type: "message", message: raw.message as AgentMessage };
    case "compaction":
      return {
        ...base,
        type: "compaction",
        summary: String(raw.summary ?? ""),
        retainedTail: jsonValue(raw.retainedTail ?? []) as unknown as AgentMessage[],
        tokensBefore: Number(raw.tokensBefore ?? 0),
        fromHook: false,
        ...optionalAnnotations(raw),
      };
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: typeof raw.fromId === "string" ? raw.fromId : null,
        summary: String(raw.summary ?? ""),
        fromHook: false,
        ...optionalAnnotations(raw),
      };
    case "custom":
      return {
        ...base,
        type: "custom",
        customType: String(raw.customType ?? "legacy"),
        data: raw.data !== undefined ? jsonValue(raw.data) : undefined,
      };
    case "model_change":
    case "thinking_level_change":
    case "active_tools_change": {
      const { id: _id, parentId: _parentId, seq: _seq, timestamp: _timestamp, type, ...data } = raw;
      return {
        ...base,
        type: "custom",
        customType: `mikan.pi084.${String(type)}`,
        data: jsonValue(data),
      };
    }
    default:
      throw new Error(`Unsupported Pi 0.84 entry type: ${String(raw.type)}`);
  }
}

function applyFact(state: Pi084Mutations, value: Record<string, unknown>): boolean {
  if (value.fact === "name") {
    state.name = typeof value.name === "string" ? value.name : undefined;
    return true;
  }
  if (value.fact !== "label" || typeof value.targetId !== "string") return false;
  if (typeof value.label === "string") state.labels.set(value.targetId, value.label);
  else state.labels.delete(value.targetId);
  return true;
}

function applyMutation(state: Pi084Mutations, value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case "entry": {
      const entry = convertEntry(value);
      state.entries.push(entry);
      if (typeof value.lane === "string") state.branchTips.set(value.lane, entry.id);
      return true;
    }
    case "lane": {
      if (typeof value.lane !== "string") return false;
      state.branchTips.set(value.lane, typeof value.leafId === "string" ? value.leafId : null);
      return true;
    }
    case "fact":
      return applyFact(state, value);
    case "record":
      state.records.push(jsonValue(value));
      return true;
    default:
      return false;
  }
}

function sessionMetadata(header: Pi084Header): Record<string, JsonValue> | undefined {
  const metadata = header.metadata ? structuredClone(header.metadata) : undefined;
  if (!header.legacyParentSessionPath || metadata?.parentSessionPath !== undefined) return metadata;
  const withParent = metadata ?? {};
  withParent.parentSessionPath = header.legacyParentSessionPath;
  return withParent;
}

interface Pi084Lines {
  lines: string[];
  torn: boolean;
  filePath: string;
}

function readLines(filePath: string): Pi084Lines {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return { lines, torn: !source.endsWith("\n"), filePath };
}

function parseLine({ lines, torn, filePath }: Pi084Lines, index: number): unknown {
  try {
    return JSON.parse(lines[index] ?? "");
  } catch (error) {
    if (index === lines.length - 1 && torn) return undefined;
    throw new Error(`Invalid JSON on line ${index + 1}: ${filePath}`, { cause: error });
  }
}

function replayMutations(state: Pi084Mutations, file: Pi084Lines): void {
  for (let index = 1; index < file.lines.length; index++) {
    const value = parseLine(file, index);
    if (value === undefined) return;
    const where = `line ${index + 1}: ${file.filePath}`;
    if (!isRecord(value)) throw new Error(`Invalid mutation on ${where}`);
    if (!applyMutation(state, value)) throw new Error(`Unknown Pi 0.84 mutation on ${where}`);
  }
}

function parsePi084Session(filePath: string): ParsedPi084Session {
  const file = readLines(filePath);
  const headerValue = file.lines.length === 0 ? undefined : parseLine(file, 0);
  if (headerValue === undefined) throw new Error(`Missing Pi 0.84 session header: ${filePath}`);
  const header = parseHeader(headerValue, filePath);
  const state: Pi084Mutations = {
    entries: [],
    branchTips: new Map([["main", null]]),
    labels: new Map(),
    records: [],
  };
  replayMutations(state, file);
  return { ...state, header, metadata: sessionMetadata(header) };
}

function encodeCurrentSession(source: ParsedPi084Session): string {
  const { header } = source;
  const writer = new V4FileWriter({
    v: 4,
    kind: "header",
    id: header.id,
    storageVersion: 1,
    createdAt: header.createdAt,
    cwd: header.cwd,
    parentSessionId: header.parentSessionId,
    legacyParentSessionPath: header.legacyParentSessionPath,
  });
  for (const entry of source.entries) writer.entry(entry);
  for (const [branch, tip] of source.branchTips) writer.set("pi.branch.tip", branch, tip);
  if (source.name !== undefined) writer.set("pi.session.name", "", source.name);
  for (const [targetId, label] of source.labels) writer.set("pi.entry.label", targetId, label);
  if (source.metadata !== undefined) writer.set("mikan", "metadata", source.metadata);
  for (const record of source.records) writer.append("mikan.pi084.records", "", record);
  return writer.toString();
}

function currentWrites(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown> | Array<Record<string, unknown>>;
      return Array.isArray(parsed) ? parsed : [parsed];
    });
}

function valueWritten(
  writes: Array<Record<string, unknown>>,
  namespace: string,
  key: string,
): unknown {
  return writes.findLast(
    (write) =>
      write.kind === "value" &&
      write.op === "set" &&
      write.namespace === namespace &&
      write.key === key,
  )?.value;
}

function verifyEntries(entries: Entry[], source: Entry[]): void {
  if (entries.length !== source.length) throw new Error("entry count changed");
  for (const [index, entry] of entries.entries()) {
    const original = source[index];
    if (!original) throw new Error(`entry ${index + 1} changed`);
    const { seq: _entrySeq, ...entryData } = entry;
    const { seq: _originalSeq, ...originalData } = original;
    if (JSON.stringify(entryData) !== JSON.stringify(originalData)) {
      throw new Error(`entry ${index + 1} changed`);
    }
  }
}

function verifyValues(
  writes: Array<Record<string, unknown>>,
  namespace: string,
  expected: ReadonlyMap<string, string | null>,
  describe: (key: string) => string,
): void {
  for (const [key, value] of expected) {
    if (valueWritten(writes, namespace, key) !== value) throw new Error(describe(key));
  }
}

function verifyValueWrites(path: string, source: ParsedPi084Session): void {
  const writes = currentWrites(path);
  verifyValues(writes, "pi.branch.tip", source.branchTips, (key) => `branch ${key} tip changed`);
  verifyValues(writes, "pi.entry.label", source.labels, (key) => `label ${key} changed`);
  if (
    JSON.stringify(valueWritten(writes, "mikan", "metadata")) !== JSON.stringify(source.metadata)
  ) {
    throw new Error("mikan metadata changed");
  }
  const auditRecords = writes.filter(
    (write) => write.kind === "list" && write.namespace === "mikan.pi084.records",
  );
  if (auditRecords.length !== source.records.length) throw new Error("audit records changed");
}

async function verifyCandidate(path: string, source: ParsedPi084Session): Promise<void> {
  const inspection = await SessionStore.inspect(path);
  verifyEntries(await inspection.getEntries(), source.entries);
  const branch = await inspection.getBranch();
  if ((branch.at(-1)?.id ?? null) !== (source.branchTips.get("main") ?? null)) {
    throw new Error("main branch tip changed");
  }
  if ((await inspection.getSessionName()) !== source.name) throw new Error("session name changed");
  const header = inspection.getHeader();
  if (
    header.id !== source.header.id ||
    header.timestamp !== new Date(source.header.createdAt).toISOString()
  ) {
    throw new Error("session identity changed");
  }
  verifyValueWrites(path, source);
}

export async function migratePi084SessionFile(
  filePath: string,
  options?: { dryRun?: boolean },
): Promise<Pi084MigrationResult> {
  let headerValue: unknown;
  try {
    headerValue = JSON.parse(firstLine(filePath));
  } catch {
    return { file: filePath, status: "not-pi-084" };
  }
  if (isCurrentHeader(headerValue)) return { file: filePath, status: "already-current" };
  if (!isPi084SessionFile(filePath)) return { file: filePath, status: "not-pi-084" };
  const sourceBytes = readFileSync(filePath);
  const source = parsePi084Session(filePath);
  if (options?.dryRun) return { file: filePath, status: "migrated", detail: "dry run" };

  await commitMigration({
    filePath,
    sourceBytes,
    encoded: encodeCurrentSession(source),
    tempPath: `${filePath}.pi-085.tmp`,
    backupPath: `${filePath}.pi-084.bak`,
    verify: (candidatePath) => verifyCandidate(candidatePath, source),
  });
  return { file: filePath, status: "migrated" };
}

export function findPi084SessionFiles(root: string): string[] {
  return findSessionFiles(root, isPi084SessionFile);
}
