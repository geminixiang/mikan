/**
 * One-time migration of legacy v3 session files to pi's v4 JSONL format.
 *
 * v3 is the entry family mikan wrote up to pi 0.83: a `{"type":"session"}`
 * header followed by tree entries with string ISO timestamps and compaction
 * entries that point at `firstKeptEntryId`. v4 (pi 0.84+) uses a
 * `{"kind":"header","version":4}` header followed by mutation lines whose
 * entries carry numeric timestamps and a consecutive `seq`, with compaction
 * retention stored inline as `retainedTail`.
 *
 * The migration preserves entry ids, parent links, and timestamps, converts
 * `custom_message` entries into v4 `custom`-role messages, folds
 * `session_info` into the v4 name fact, `label` entries into label facts,
 * and rewrites each compaction's kept range into its inline `retainedTail`.
 * Every migrated file is verified before it replaces the original: the v4
 * file is re-opened with pi's reader and its built context must equal the
 * v3 context computed by the reference converter below. The original file
 * is kept beside the migrated one as `<name>.v3.bak`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildSessionContext,
  createCustomMessage,
  type AgentMessage,
  type Entry as PiEntry,
  type JsonlV4Header,
} from "@earendil-works/pi-agent-core";
import { SessionStore } from "../harness/session-store.js";
import { atomicWritePrivateFile } from "../utils/file-guards.js";

// ── v3 shapes ────────────────────────────────────────────────────────────────

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

/** Whether a file's first non-empty line is a v3 session header. */
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

/** Read a v3 session file, ignoring a torn final line (crash tail). */
function readV3SessionFile(filePath: string): V3SessionFile {
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
  const header = records[0];
  if (!header || header.type !== "session" || typeof header.id !== "string") {
    throw new Error(`Not a v3 session file: ${filePath}`);
  }
  // Crash-era v3 files can contain duplicated lines (a retried append wrote
  // the header+entry pair twice). The v3 runtime read entries into a Map, so
  // duplicates were silently collapsed; v4 rejects duplicate mutation ids.
  // Reproduce the v3 semantics: keep one entry per id, drop stray repeated
  // session headers.
  const seen = new Set<string>();
  const entries: V3Entry[] = [];
  for (const record of records.slice(1)) {
    if (typeof record.type !== "string" || typeof record.id !== "string") continue;
    if (record.type === "session") continue;
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    entries.push(record as unknown as V3Entry);
  }
  return { header: header as unknown as V3SessionHeader, entries };
}

function toEpochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Walk a v3 tree from an entry to the root; returns root-first path order. */
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

/** Convert one tree-shaping v3 entry to its v4 counterpart (facts excluded). */
function convertEntry(entry: V3Entry, entries: V3Entry[]): PiEntry | null {
  const base = {
    id: entry.id,
    seq: 0, // assigned at mutation-encoding time
    parentId: resolveV4Parent(entry, entries),
    timestamp: toEpochMillis(entry.timestamp),
  };
  switch (entry.type) {
    case "message":
      return { ...base, type: "message", message: entry.message };
    case "custom_message":
      return {
        ...base,
        type: "message",
        message: createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          toEpochMillis(entry.timestamp),
        ),
      };
    case "thinking_level_change":
      return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
    case "model_change":
      return { ...base, type: "model_change", provider: entry.provider, modelId: entry.modelId };
    case "active_tools_change":
      return { ...base, type: "active_tools_change", activeToolNames: entry.activeToolNames };
    case "compaction":
      return {
        ...base,
        type: "compaction",
        summary: entry.summary,
        retainedTail: entry.retainedTail ?? compactionKeptMessages(entry, entries),
        tokensBefore: entry.tokensBefore,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        ...(entry.usage !== undefined ? { usage: entry.usage as PiEntry & object } : {}),
      } as unknown as PiEntry;
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: entry.fromId,
        summary: entry.summary,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      } as unknown as PiEntry;
    case "custom":
      return { ...base, type: "custom", customType: entry.customType, data: entry.data };
    default:
      // session_info / label / leaf become facts and the lane pointer.
      return null;
  }
}

/**
 * Skip fact-only ancestors (session_info/label/leaf) when re-linking the v4
 * tree: those entries disappear from the entry stream, so children re-attach
 * to the nearest surviving ancestor.
 */
function resolveV4Parent(entry: V3Entry, entries: V3Entry[]): string | null {
  const byId = new Map(entries.map((item) => [item.id, item]));
  let parentId = entry.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (parent.type !== "session_info" && parent.type !== "label" && parent.type !== "leaf") {
      return parentId;
    }
    parentId = parent.parentId;
  }
  return null;
}

/**
 * Messages of the v3 kept range (`firstKeptEntryId` .. compaction parent),
 * which v4 stores inline on the compaction entry.
 */
function compactionKeptMessages(
  compaction: Extract<V3Entry, { type: "compaction" }>,
  entries: V3Entry[],
): AgentMessage[] {
  if (!compaction.firstKeptEntryId) return [];
  const ancestors = v3Branch(entries, compaction.parentId);
  const keptStart = ancestors.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (keptStart === -1) return [];
  const messages: AgentMessage[] = [];
  for (const entry of ancestors.slice(keptStart)) {
    if (entry.type === "message") messages.push(entry.message);
    else if (entry.type === "custom_message") {
      messages.push(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          toEpochMillis(entry.timestamp),
        ),
      );
    }
  }
  return messages;
}

// ── reference converter (verification oracle) ───────────────────────────────

/**
 * Convert a v3 branch to v4 entries with the pi-0.83 context semantics:
 * the last compaction is repositioned ahead of its kept range so pi's v4
 * transform reproduces the v3 context exactly. This mirrors what the
 * runtime shim did before mikan moved to native v4 files, and serves as
 * the verification oracle for migrated output.
 */
function referenceContextEntries(branch: V3Entry[]): PiEntry[] {
  let lastCompactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") {
      lastCompactionIndex = i;
      break;
    }
  }
  const lastCompaction = branch[lastCompactionIndex] as
    | Extract<V3Entry, { type: "compaction" }>
    | undefined;
  const firstKeptId =
    lastCompaction && !lastCompaction.retainedTail ? lastCompaction.firstKeptEntryId : undefined;
  const firstKeptIndex =
    firstKeptId === undefined ? -1 : branch.findIndex((entry) => entry.id === firstKeptId);

  const ordered: V3Entry[] = [];
  if (firstKeptIndex !== -1 && lastCompaction) {
    ordered.push(...branch.slice(0, firstKeptIndex));
    ordered.push(lastCompaction);
    for (const [index, entry] of branch.entries()) {
      if (index >= firstKeptIndex && index !== lastCompactionIndex) ordered.push(entry);
    }
  } else {
    ordered.push(...branch);
  }

  const converted: PiEntry[] = [];
  for (const entry of ordered) {
    if (entry.type === "compaction" && entry === lastCompaction && firstKeptIndex !== -1) {
      converted.push({
        type: "compaction",
        id: entry.id,
        seq: 0,
        parentId: null,
        timestamp: toEpochMillis(entry.timestamp),
        summary: entry.summary,
        retainedTail: [],
        tokensBefore: entry.tokensBefore,
      });
      continue;
    }
    const piEntry = convertEntry(entry, []);
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

// ── v4 encoding ─────────────────────────────────────────────────────────────

function buildV4Header(header: V3SessionHeader): JsonlV4Header {
  const {
    type: _type,
    version: _version,
    id,
    timestamp,
    cwd,
    parentSession,
    parentSessionId,
    ...extras
  } = header;
  const metadata: Record<string, unknown> = { ...extras };
  if (parentSession !== undefined) metadata.parentSessionPath = parentSession;
  return {
    kind: "header",
    version: 4,
    id,
    createdAt: toEpochMillis(timestamp),
    cwd,
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
    ...(Object.keys(metadata).length > 0
      ? { metadata: metadata as JsonlV4Header["metadata"] }
      : {}),
  };
}

function encodeV4File(file: V3SessionFile): string {
  const lines: string[] = [JSON.stringify(buildV4Header(file.header))];
  let seq = 0;
  const push = (mutation: Record<string, unknown>) => {
    lines.push(JSON.stringify(mutation));
  };

  let name: string | undefined;
  const labels: Array<{ targetId: string; label: string | undefined }> = [];
  for (const entry of file.entries) {
    if (entry.type === "session_info") {
      name = entry.name?.trim() || undefined;
      continue;
    }
    if (entry.type === "label") {
      labels.push({ targetId: entry.targetId, label: entry.label });
      continue;
    }
    if (entry.type === "leaf") continue;
    const converted = convertEntry(entry, file.entries);
    if (!converted) continue;
    converted.seq = ++seq;
    // Entry mutations are encoded flat: {kind:"entry", ...entry fields}.
    push({ kind: "entry", ...converted });
  }

  const leafId = v3LeafId(file.entries);
  push({ kind: "lane", seq: ++seq, lane: "main", leafId });
  if (name !== undefined) push({ kind: "fact", seq: ++seq, fact: "name", name });
  for (const { targetId, label } of labels) {
    push({ kind: "fact", seq: ++seq, fact: "label", targetId, label });
  }
  return `${lines.join("\n")}\n`;
}

// ── migration driver ────────────────────────────────────────────────────────

export interface MigrateResult {
  file: string;
  status: "migrated" | "already-v4" | "skipped";
  detail?: string;
}

async function verifyMigratedFile(v4Path: string, source: V3SessionFile): Promise<void> {
  const store = await SessionStore.inspect(v4Path);
  const migratedContext = await store.buildSessionContext();
  const branch = v3Branch(source.entries, v3LeafId(source.entries));
  const referenceContext = buildSessionContext(referenceContextEntries(branch));
  const migrated = JSON.stringify(migratedContext.messages);
  const reference = JSON.stringify(referenceContext.messages);
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

/**
 * Migrate one session file in place. The migrated file is verified against
 * the v3 reference semantics before it replaces the original; the original
 * is preserved as `<file>.v3.bak`.
 */
export async function migrateSessionFile(
  filePath: string,
  options?: { dryRun?: boolean },
): Promise<MigrateResult> {
  if (!isV3SessionFile(filePath)) return { file: filePath, status: "already-v4" };
  const source = readV3SessionFile(filePath);
  if (options?.dryRun) return { file: filePath, status: "migrated", detail: "dry run" };

  const tempPath = `${filePath}.v4.tmp`;
  atomicWritePrivateFile(tempPath, encodeV4File(source));
  try {
    await verifyMigratedFile(tempPath, source);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw new Error(`Verification failed for ${filePath}`, { cause: error });
  }
  renameSync(filePath, `${filePath}.v3.bak`);
  renameSync(tempPath, filePath);
  return { file: filePath, status: "migrated" };
}

/** Recursively find candidate session files (.jsonl with a v3 header). */
export function findV3SessionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(path);
      } else if (name.endsWith(".jsonl") && isV3SessionFile(path)) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found;
}
