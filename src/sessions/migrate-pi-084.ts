import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentMessage, Entry, JsonValue } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { SessionStore } from "../harness/session-store.js";
import { atomicWritePrivateFile, isRecord } from "../utils/file-guards.js";
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

interface ParsedPi084Session {
  header: Pi084Header;
  entries: Entry[];
  branchTips: Map<string, string | null>;
  name?: string;
  labels: Map<string, string>;
  records: JsonValue[];
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

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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
        ...(raw.details !== undefined ? { details: jsonValue(raw.details) } : {}),
        ...(raw.usage !== undefined ? { usage: raw.usage as Usage } : {}),
      };
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: typeof raw.fromId === "string" ? raw.fromId : null,
        summary: String(raw.summary ?? ""),
        fromHook: false,
        ...(raw.details !== undefined ? { details: jsonValue(raw.details) } : {}),
        ...(raw.usage !== undefined ? { usage: raw.usage as Usage } : {}),
      };
    case "custom":
      return {
        ...base,
        type: "custom",
        customType: String(raw.customType ?? "legacy"),
        ...(raw.data !== undefined ? { data: jsonValue(raw.data) } : {}),
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

function parsePi084Session(filePath: string): ParsedPi084Session {
  const source = readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let header: Pi084Header | undefined;
  const entries: Entry[] = [];
  const branchTips = new Map<string, string | null>([["main", null]]);
  const labels = new Map<string, string>();
  const records: JsonValue[] = [];
  let name: string | undefined;

  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && !source.endsWith("\n")) break;
      throw new Error(`Invalid JSON on line ${index + 1}: ${filePath}`, { cause: error });
    }
    if (index === 0) {
      header = parseHeader(value, filePath);
      continue;
    }
    if (!isRecord(value)) throw new Error(`Invalid mutation on line ${index + 1}: ${filePath}`);
    if (value.kind === "entry") {
      const entry = convertEntry(value);
      entries.push(entry);
      if (typeof value.lane === "string") branchTips.set(value.lane, entry.id);
    } else if (value.kind === "lane" && typeof value.lane === "string") {
      branchTips.set(value.lane, typeof value.leafId === "string" ? value.leafId : null);
    } else if (value.kind === "fact" && value.fact === "name") {
      name = typeof value.name === "string" ? value.name : undefined;
    } else if (
      value.kind === "fact" &&
      value.fact === "label" &&
      typeof value.targetId === "string"
    ) {
      if (typeof value.label === "string") labels.set(value.targetId, value.label);
      else labels.delete(value.targetId);
    } else if (value.kind === "record") {
      records.push(jsonValue(value));
    } else {
      throw new Error(`Unknown Pi 0.84 mutation on line ${index + 1}: ${filePath}`);
    }
  }
  if (!header) throw new Error(`Missing Pi 0.84 session header: ${filePath}`);
  let metadata = header.metadata ? structuredClone(header.metadata) : undefined;
  if (header.legacyParentSessionPath && metadata?.parentSessionPath === undefined) {
    (metadata ??= {}).parentSessionPath = header.legacyParentSessionPath;
  }
  return { header, entries, branchTips, name, labels, records, metadata };
}

function encodeCurrentSession(source: ParsedPi084Session): string {
  const header = {
    v: 4,
    kind: "header",
    id: source.header.id,
    storageVersion: 1,
    createdAt: source.header.createdAt,
    cwd: source.header.cwd,
    ...(source.header.parentSessionId !== undefined
      ? { parentSessionId: source.header.parentSessionId }
      : {}),
    ...(source.header.legacyParentSessionPath !== undefined
      ? { legacyParentSessionPath: source.header.legacyParentSessionPath }
      : {}),
  };
  const lines = [JSON.stringify(header)];
  let seq = 0;
  for (const entry of source.entries) {
    lines.push(JSON.stringify({ kind: "entry", ...entry, seq: ++seq }));
  }
  for (const [branch, tip] of source.branchTips) {
    lines.push(
      JSON.stringify({
        kind: "value",
        op: "set",
        seq: ++seq,
        namespace: "pi.branch.tip",
        key: branch,
        value: tip,
      }),
    );
  }
  if (source.name !== undefined) {
    lines.push(
      JSON.stringify({
        kind: "value",
        op: "set",
        seq: ++seq,
        namespace: "pi.session.name",
        key: "",
        value: source.name,
      }),
    );
  }
  for (const [targetId, label] of source.labels) {
    lines.push(
      JSON.stringify({
        kind: "value",
        op: "set",
        seq: ++seq,
        namespace: "pi.entry.label",
        key: targetId,
        value: label,
      }),
    );
  }
  if (source.metadata !== undefined) {
    lines.push(
      JSON.stringify({
        kind: "value",
        op: "set",
        seq: ++seq,
        namespace: "mikan",
        key: "metadata",
        value: source.metadata,
      }),
    );
  }
  for (const record of source.records) {
    lines.push(
      JSON.stringify({
        kind: "list",
        op: "append",
        seq: ++seq,
        namespace: "mikan.pi084.records",
        key: "",
        value: record,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
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

async function verifyCandidate(path: string, source: ParsedPi084Session): Promise<void> {
  const inspection = await SessionStore.inspect(path);
  const entries = await inspection.getEntries();
  if (entries.length !== source.entries.length) throw new Error("entry count changed");
  for (const [index, entry] of entries.entries()) {
    const original = source.entries[index];
    if (!original) throw new Error(`entry ${index + 1} changed`);
    const { seq: _entrySeq, ...entryData } = entry;
    const { seq: _originalSeq, ...originalData } = original;
    if (JSON.stringify(entryData) !== JSON.stringify(originalData)) {
      throw new Error(`entry ${index + 1} changed`);
    }
  }
  const expectedTip = source.branchTips.get("main") ?? null;
  const branch = await inspection.getBranch();
  if ((branch.at(-1)?.id ?? null) !== expectedTip) throw new Error("main branch tip changed");
  if ((await inspection.getSessionName()) !== source.name) throw new Error("session name changed");
  const header = inspection.getHeader();
  if (
    header.id !== source.header.id ||
    header.timestamp !== new Date(source.header.createdAt).toISOString()
  ) {
    throw new Error("session identity changed");
  }
  const writes = currentWrites(path);
  for (const [branchName, tip] of source.branchTips) {
    if (valueWritten(writes, "pi.branch.tip", branchName) !== tip) {
      throw new Error(`branch ${branchName} tip changed`);
    }
  }
  for (const [targetId, label] of source.labels) {
    if (valueWritten(writes, "pi.entry.label", targetId) !== label) {
      throw new Error(`label ${targetId} changed`);
    }
  }
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

function backupAlreadyLinked(sourcePath: string, backupPath: string): boolean {
  if (!existsSync(backupPath)) return false;
  const source = statSync(sourcePath);
  const backup = statSync(backupPath);
  if (source.dev === backup.dev && source.ino === backup.ino) return true;
  throw new Error(`Backup already exists: ${backupPath}`);
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

  const tempPath = `${filePath}.pi-085.tmp`;
  const backupPath = `${filePath}.pi-084.bak`;
  const backupLinked = backupAlreadyLinked(filePath, backupPath);
  atomicWritePrivateFile(tempPath, encodeCurrentSession(source));
  try {
    await verifyCandidate(tempPath, source);
    if (!readFileSync(filePath).equals(sourceBytes))
      throw new Error("source changed during migration");
    if (!backupLinked) linkSync(filePath, backupPath);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw new Error(`Migration failed for ${filePath}`, { cause: error });
  }
  return { file: filePath, status: "migrated" };
}

export function findPi084SessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) walk(path);
      else if (name.endsWith(".jsonl") && isPi084SessionFile(path)) found.push(path);
    }
  };
  walk(root);
  return found;
}
