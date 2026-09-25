import { readFileSync } from "node:fs";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  type AgentMessage,
  type Entry as PiEntry,
  type JsonValue,
} from "@earendil-works/pi-agent-core";
import { SessionStore } from "./session-store.js";
import {
  commitMigration,
  findSessionFiles,
  optionalAnnotations,
  V4FileWriter,
} from "./migrate-common.js";
import type { MigrateResult } from "./types.js";
export type { MigrateResult } from "./types.js";

interface V3EntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

type V3Entry = V3EntryBase &
  (
    | { type: "message"; message: AgentMessage }
    | { type: "thinking_level_change"; thinkingLevel: string }
    | { type: "model_change"; provider: string; modelId: string }
    | { type: "active_tools_change"; activeToolNames: string[] }
    | {
        type: "compaction";
        summary: string;
        firstKeptEntryId?: string;
        tokensBefore: number;
        retainedTail?: AgentMessage[];
        details?: unknown;
        usage?: unknown;
      }
    | {
        type: "branch_summary";
        fromId: string;
        summary: string;
        details?: unknown;
        usage?: unknown;
      }
    | { type: "custom"; customType: string; data?: unknown }
    | {
        type: "custom_message";
        customType: string;
        content: Parameters<typeof createCustomMessage>[1];
        display: boolean;
        details?: unknown;
      }
    | { type: "label"; targetId: string; label: string | undefined }
    | { type: "session_info"; name?: string }
    | { type: "leaf"; targetId: string | null }
  );

type V3Compaction = Extract<V3Entry, { type: "compaction" }>;
type V3CustomMessage = Extract<V3Entry, { type: "custom_message" }>;

interface V3SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  parentSessionId?: string;
  [extra: string]: unknown;
}

interface V3SessionFile {
  header: V3SessionHeader;
  entries: V3Entry[];
}

function isFactEntry(entry: V3Entry): boolean {
  return entry.type === "session_info" || entry.type === "label" || entry.type === "leaf";
}

export function isV3SessionFile(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    const firstLine = content.split("\n").find((line) => line.trim().length > 0);
    if (!firstLine) return false;
    const parsed = JSON.parse(firstLine) as { type?: unknown };
    return parsed.type === "session";
  } catch {
    return false;
  }
}

function parseJsonLines(filePath: string): Record<string, unknown>[] {
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch (error) {
      if (index === lines.length - 1 && index > 0) continue;
      throw new Error(`Invalid JSON on line ${index + 1} of ${filePath}`, { cause: error });
    }
  }
  return records;
}

function dedupeEntries(records: Record<string, unknown>[]): V3Entry[] {
  const entriesById = new Map<string, V3Entry>();
  for (const record of records) {
    if (typeof record.type !== "string" || typeof record.id !== "string") continue;
    if (record.type === "session") continue;
    entriesById.set(record.id, record as unknown as V3Entry);
  }
  return [...entriesById.values()];
}

function readV3SessionFile(filePath: string): V3SessionFile {
  const records = parseJsonLines(filePath);
  const header = records[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    throw new Error(`Not a v3 session file: ${filePath}`);
  }
  return {
    header: header as unknown as V3SessionHeader,
    entries: dedupeEntries(records.slice(1)),
  };
}

function toEpochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function v3Branch(entries: V3Entry[], fromId: string | null): V3Entry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: V3Entry[] = [];
  let currentId = fromId;
  while (currentId) {
    const entry = byId.get(currentId);
    if (!entry) break;
    path.push(entry);
    currentId = entry.parentId;
  }
  return path.toReversed();
}

function v3LeafId(entries: V3Entry[]): string | null {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }
  return leafId;
}

function customMessageOf(entry: V3CustomMessage): AgentMessage {
  return createCustomMessage(
    entry.customType,
    entry.content,
    entry.display,
    entry.details,
    toEpochMillis(entry.timestamp),
  );
}

function convertEntry(entry: V3Entry, entries: V3Entry[]): PiEntry | null {
  const base = {
    id: entry.id,
    seq: 0,
    parentId: resolveV4Parent(entry, entries),
    timestamp: toEpochMillis(entry.timestamp),
  };
  switch (entry.type) {
    case "message":
      return { ...base, type: "message", message: entry.message };
    case "custom_message":
      return { ...base, type: "message", message: customMessageOf(entry) };
    case "thinking_level_change":
    case "model_change":
    case "active_tools_change": {
      const { id: _id, parentId: _parentId, timestamp: _timestamp, type, ...data } = entry;
      return {
        ...base,
        type: "custom",
        customType: `mikan.legacy.${type}`,
        data: data as JsonValue,
      };
    }
    case "compaction":
      return {
        ...base,
        type: "compaction",
        summary: entry.summary,
        retainedTail: entry.retainedTail ?? compactionKeptMessages(entry, entries),
        tokensBefore: entry.tokensBefore,
        fromHook: false,
        ...optionalAnnotations(entry),
      } as unknown as PiEntry;
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: entry.fromId ?? null,
        summary: entry.summary,
        fromHook: false,
        ...optionalAnnotations(entry),
      } as unknown as PiEntry;
    case "custom":
      return {
        ...base,
        type: "custom",
        customType: entry.customType,
        data: entry.data as JsonValue | undefined,
      };
    default:
      return null;
  }
}

function resolveV4Parent(entry: V3Entry, entries: V3Entry[]): string | null {
  const byId = new Map(entries.map((item) => [item.id, item]));
  let parentId = entry.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (!isFactEntry(parent)) return parentId;
    parentId = parent.parentId;
  }
  return null;
}

function compactionKeptMessages(compaction: V3Compaction, entries: V3Entry[]): AgentMessage[] {
  if (!compaction.firstKeptEntryId) return [];
  const ancestors = v3Branch(entries, compaction.parentId);
  const keptStart = ancestors.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (keptStart === -1) return [];
  const messages: AgentMessage[] = [];
  for (const entry of ancestors.slice(keptStart)) {
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "custom_message") messages.push(customMessageOf(entry));
  }
  return messages;
}

function orderForReference(branch: V3Entry[]): {
  ordered: V3Entry[];
  repositioned?: V3Compaction;
} {
  const lastIndex = branch.findLastIndex((entry) => entry.type === "compaction");
  const lastCompaction = branch[lastIndex] as V3Compaction | undefined;
  const firstKeptId = lastCompaction?.retainedTail ? undefined : lastCompaction?.firstKeptEntryId;
  const firstKeptIndex =
    firstKeptId === undefined ? -1 : branch.findIndex((entry) => entry.id === firstKeptId);
  if (firstKeptIndex === -1 || !lastCompaction) return { ordered: branch };
  return {
    ordered: [
      ...branch.slice(0, firstKeptIndex),
      lastCompaction,
      ...branch.filter((_, index) => index >= firstKeptIndex && index !== lastIndex),
    ],
    repositioned: lastCompaction,
  };
}

function emptiedCompaction(entry: V3Compaction): PiEntry {
  return {
    type: "compaction",
    id: entry.id,
    seq: 0,
    parentId: null,
    timestamp: toEpochMillis(entry.timestamp),
    summary: entry.summary,
    retainedTail: [],
    tokensBefore: entry.tokensBefore,
    fromHook: false,
  };
}

function referenceContextEntries(branch: V3Entry[]): PiEntry[] {
  const { ordered, repositioned } = orderForReference(branch);
  const converted: PiEntry[] = [];
  for (const entry of ordered) {
    const piEntry =
      repositioned === entry ? emptiedCompaction(repositioned) : convertEntry(entry, []);
    if (piEntry) converted.push(piEntry);
  }
  let previousId: string | null = null;
  for (const [index, entry] of converted.entries()) {
    entry.seq = index;
    entry.parentId = previousId;
    previousId = entry.id;
  }
  return converted;
}

function isCurrentContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

function contextMessagesOf(entry: PiEntry): AgentMessage[] {
  if (entry.type === "message") {
    return isCurrentContextMessage(entry.message) ? [entry.message] : [];
  }
  if (entry.type === "compaction") {
    return [
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      ...entry.retainedTail.filter(isCurrentContextMessage),
    ];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
  }
  return [];
}

function referenceContextMessages(entries: PiEntry[]): AgentMessage[] {
  const compactionIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const visible = compactionIndex === -1 ? entries : entries.slice(compactionIndex);
  return visible.flatMap(contextMessagesOf);
}

function buildV4Header(header: V3SessionHeader): Record<string, unknown> {
  return {
    v: 4,
    kind: "header",
    id: header.id,
    storageVersion: 1,
    createdAt: toEpochMillis(header.timestamp),
    cwd: header.cwd,
    parentSessionId: header.parentSessionId,
    legacyParentSessionPath: header.parentSession,
  };
}

function partitionEntries(entries: V3Entry[]): {
  tree: V3Entry[];
  name?: string;
  labels: Array<{ targetId: string; label: string | undefined }>;
} {
  const tree: V3Entry[] = [];
  const labels: Array<{ targetId: string; label: string | undefined }> = [];
  let name: string | undefined;
  for (const entry of entries) {
    switch (entry.type) {
      case "session_info":
        name = entry.name?.trim() || undefined;
        break;
      case "label":
        labels.push({ targetId: entry.targetId, label: entry.label });
        break;
      case "leaf":
        break;
      default:
        tree.push(entry);
    }
  }
  return { tree, name, labels };
}

function resolveV4Leaf(entries: V3Entry[]): string | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let leafId = v3LeafId(entries);
  while (leafId !== null) {
    const target = byId.get(leafId);
    if (!target) return null;
    if (!isFactEntry(target)) return leafId;
    leafId = target.parentId;
  }
  return null;
}

function headerMetadata(header: V3SessionHeader): Record<string, JsonValue> | undefined {
  const {
    type: _type,
    version: _version,
    id: _id,
    timestamp: _timestamp,
    cwd: _cwd,
    parentSession,
    parentSessionId: _parentSessionId,
    ...extras
  } = header;
  const metadata: Record<string, JsonValue> = extras as Record<string, JsonValue>;
  if (parentSession !== undefined) metadata.parentSessionPath = parentSession;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function encodeV4File(file: V3SessionFile): string {
  const writer = new V4FileWriter(buildV4Header(file.header));
  const { tree, name, labels } = partitionEntries(file.entries);
  for (const entry of tree) {
    const converted = convertEntry(entry, file.entries);
    if (converted) writer.entry(converted);
  }
  writer.set("pi.branch.tip", "main", resolveV4Leaf(file.entries));
  if (name !== undefined) writer.set("pi.session.name", "", name);
  for (const { targetId, label } of labels) {
    if (label !== undefined) writer.set("pi.entry.label", targetId, label);
  }
  const metadata = headerMetadata(file.header);
  if (metadata) writer.set("mikan", "metadata", metadata);
  return writer.toString();
}

async function verifyMigratedFile(v4Path: string, source: V3SessionFile): Promise<void> {
  const store = await SessionStore.inspect(v4Path);
  const migratedContext = await store.buildSessionContext();
  const branch = v3Branch(source.entries, v3LeafId(source.entries));
  const migrated = JSON.stringify(migratedContext.messages);
  const reference = JSON.stringify(referenceContextMessages(referenceContextEntries(branch)));
  if (migrated !== reference) {
    throw new Error("migrated context does not match the v3 reference context");
  }
  const migratedName = await store.getSessionName();
  const v3Name = [...source.entries]
    .toReversed()
    .find((entry) => entry.type === "session_info")
    ?.name?.trim();
  if ((migratedName ?? "") !== (v3Name || "")) {
    throw new Error("migrated session name does not match the v3 session name");
  }
}

export async function migrateSessionFile(
  filePath: string,
  options?: { dryRun?: boolean },
): Promise<MigrateResult> {
  if (!isV3SessionFile(filePath)) return { file: filePath, status: "already-v4" };
  const sourceBytes = readFileSync(filePath);
  const source = readV3SessionFile(filePath);
  if (options?.dryRun) return { file: filePath, status: "migrated", detail: "dry run" };

  await commitMigration({
    filePath,
    sourceBytes,
    encoded: encodeV4File(source),
    tempPath: `${filePath}.v4.tmp`,
    backupPath: `${filePath}.v3.bak`,
    verify: (candidatePath) => verifyMigratedFile(candidatePath, source),
  });
  return { file: filePath, status: "migrated" };
}

export function findV3SessionFiles(root: string): string[] {
  return findSessionFiles(root, isV3SessionFile);
}
