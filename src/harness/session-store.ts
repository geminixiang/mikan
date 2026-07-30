/**
 * mikan-owned session storage.
 *
 * Sessions are append-only trees stored as JSONL files: a `session` header
 * line followed by entries that carry `id`/`parentId` links. The format is
 * the v3 layout mikan has always written, and entry shapes are structurally
 * identical to pi-agent-core's `SessionTreeEntry`, so pi-agent-core's
 * context-building and compaction helpers operate on these entries directly.
 *
 * The store is synchronous by design: every mikan call site (session scope
 * resolution, chat-history sync, session view, admin portal) reads and
 * writes sessions inside synchronous flows.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildSessionContext as buildContextFromEntries } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { atomicWritePrivateFile } from "../utils/file-guards.js";
import {
  CURRENT_SESSION_VERSION,
  type SessionContext,
  type SessionEntry,
  type SessionFileEntry,
  type SessionHeader,
} from "./types.js";

/** Distributive omit so each entry variant keeps its own fields. */
type PendingSessionEntry = SessionEntry extends infer TEntry
  ? TEntry extends SessionEntry
    ? Omit<TEntry, "id" | "parentId" | "timestamp">
    : never
  : never;

/** Generate a unique short entry id (8 hex chars, collision-checked). */
function generateEntryId(byId: Map<string, SessionEntry>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return randomUUID();
}

/** Parse JSONL content tolerantly for compatibility with existing read-only callers. */
export function parseSessionFileEntries(content: string): SessionFileEntry[] {
  const entries: SessionFileEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        entries.push(parsed as SessionFileEntry);
      }
    } catch {
      // This compatibility parser is intentionally tolerant. SessionStore.open is not.
    }
  }
  return entries;
}

function isSessionHeader(entry: SessionFileEntry): entry is SessionHeader {
  return entry.type === "session" && typeof (entry as SessionHeader).id === "string";
}

type LoadedSessionFile = {
  entries: SessionFileEntry[];
  discardedCrashTail: boolean;
};

function corrupted(filePath: string, detail: string): Error {
  return new Error(
    `Session file is corrupted (${detail}): ${filePath}. Refusing to open for writing.`,
  );
}

function parseSessionLine(line: string, filePath: string, lineNumber: number): SessionFileEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw corrupted(filePath, `line ${lineNumber} is not valid JSON`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    throw corrupted(filePath, `line ${lineNumber} is not a session object`);
  }
  return parsed as SessionFileEntry;
}

function validateSessionTree(filePath: string, fileEntries: SessionFileEntry[]): void {
  const records = fileEntries.slice(1);
  const allIds = new Set<string>();
  const treeEntries = new Map<string, SessionEntry>();

  for (const [index, record] of records.entries()) {
    const lineNumber = index + 2;
    if (isSessionHeader(record)) throw corrupted(filePath, `line ${lineNumber} repeats the header`);
    const entry = record as SessionEntry;
    if (typeof entry.id !== "string" || !entry.id) {
      throw corrupted(filePath, `line ${lineNumber} has no entry id`);
    }
    if (allIds.has(entry.id)) throw corrupted(filePath, `duplicate entry id ${entry.id}`);
    allIds.add(entry.id);
    if (entry.type !== "leaf") treeEntries.set(entry.id, entry);
  }

  for (const [index, record] of records.entries()) {
    const lineNumber = index + 2;
    const entry = record as SessionEntry;
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      throw corrupted(filePath, `line ${lineNumber} has an invalid parentId`);
    }
    if (entry.parentId === entry.id)
      throw corrupted(filePath, `entry ${entry.id} is its own parent`);
    if (entry.parentId !== null && !treeEntries.has(entry.parentId)) {
      throw corrupted(filePath, `entry ${entry.id} references missing parent ${entry.parentId}`);
    }
    if (entry.type === "leaf") {
      if (entry.targetId !== null && typeof entry.targetId !== "string") {
        throw corrupted(filePath, `leaf ${entry.id} has an invalid target`);
      }
      if (entry.targetId !== null && !treeEntries.has(entry.targetId)) {
        throw corrupted(filePath, `leaf ${entry.id} references missing target ${entry.targetId}`);
      }
    }
  }

  for (const entry of treeEntries.values()) {
    const seen = new Set<string>();
    let current: SessionEntry | undefined = entry;
    while (current) {
      if (seen.has(current.id))
        throw corrupted(filePath, `parent cycle includes entry ${current.id}`);
      seen.add(current.id);
      current = current.parentId === null ? undefined : treeEntries.get(current.parentId);
    }
  }

  for (const entry of treeEntries.values()) {
    if (entry.type !== "compaction") continue;
    if (typeof entry.firstKeptEntryId !== "string" || !treeEntries.has(entry.firstKeptEntryId)) {
      throw corrupted(filePath, `compaction ${entry.id} references missing first kept entry`);
    }
    let ancestorId = entry.parentId;
    while (ancestorId !== null && ancestorId !== entry.firstKeptEntryId) {
      ancestorId = treeEntries.get(ancestorId)?.parentId ?? null;
    }
    if (ancestorId === null) {
      throw corrupted(
        filePath,
        `compaction ${entry.id} first kept entry ${entry.firstKeptEntryId} is not on its branch`,
      );
    }
  }
}

function loadValidatedSessionFile(filePath: string): LoadedSessionFile {
  if (!existsSync(filePath)) return { entries: [], discardedCrashTail: false };
  const nonEmptyLines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter(({ text }) => text.length > 0);
  if (nonEmptyLines.length === 0) return { entries: [], discardedCrashTail: false };

  const entries: SessionFileEntry[] = [];
  let discardedCrashTail = false;
  for (const [index, line] of nonEmptyLines.entries()) {
    try {
      entries.push(parseSessionLine(line.text, filePath, line.number));
    } catch (error) {
      if (index !== nonEmptyLines.length - 1 || index === 0) throw error;
      discardedCrashTail = true;
    }
  }
  if (!isSessionHeader(entries[0]))
    throw corrupted(filePath, "first non-empty line is not a valid header");
  validateSessionTree(filePath, entries);
  return { entries, discardedCrashTail };
}

/**
 * Load and validate a session file. Missing and whitespace-only files return
 * no entries. A malformed final non-empty line is ignored as a crash tail;
 * all other malformed JSON and invalid tree relationships throw.
 */
export function loadSessionFileEntries(filePath: string): SessionFileEntry[] {
  return loadValidatedSessionFile(filePath).entries;
}

/**
 * Append-oriented session store over one v3 JSONL file.
 *
 * Reading is tolerant (missing files and malformed lines yield an empty
 * session); appends persist immediately. A session opened from a file
 * without a valid header gets its header materialized on the first append.
 */
export class SessionStore {
  private readonly sessionFile: string | null;
  private readonly cwd: string;
  private readonly sessionId: string;
  private header: SessionHeader | null;
  private headerOnDisk: boolean;
  private rewriteBeforeAppend: boolean;
  private entries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;

  private constructor(
    sessionFile: string | null,
    cwd: string,
    fileEntries: SessionFileEntry[],
    rewriteBeforeAppend = false,
  ) {
    this.sessionFile = sessionFile === null ? null : resolve(sessionFile);
    this.header = fileEntries.length > 0 && isSessionHeader(fileEntries[0]) ? fileEntries[0] : null;
    this.headerOnDisk = this.header !== null;
    this.rewriteBeforeAppend = rewriteBeforeAppend;
    this.sessionId = this.header?.id ?? randomUUID();
    this.cwd = cwd;
    for (const entry of fileEntries) {
      if (isSessionHeader(entry)) continue;
      if (entry.type === "leaf") {
        // Written by pi-agent-core JSONL sessions; mikan tracks the leaf implicitly.
        this.leafId = entry.targetId;
        continue;
      }
      this.entries.push(entry);
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
    }
  }

  /**
   * Open a session file. A missing or empty file starts an empty session
   * whose header is written on the first append. A file that has content but
   * no leading session header is treated as corrupted and throws, rather than
   * being silently overwritten on the next append (which would erase the
   * existing history). Callers on read paths already wrap this in try/catch.
   * @param cwdOverride Working directory override; defaults to the header cwd.
   */
  static open(path: string, cwdOverride?: string): SessionStore {
    const loaded = loadValidatedSessionFile(path);
    const header = loaded.entries.find(isSessionHeader);
    const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
    return new SessionStore(path, cwd, loaded.entries, loaded.discardedCrashTail);
  }

  /** Create a new session file with a fresh header, replacing any existing file. */
  static create(
    path: string,
    cwd: string,
    options?: { id?: string; parentSession?: string; parentSessionId?: string },
  ): SessionStore {
    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: options?.id ?? randomUUID(),
      timestamp: new Date().toISOString(),
      cwd,
      ...(options?.parentSession ? { parentSession: options.parentSession } : {}),
      ...(options?.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    };
    atomicWritePrivateFile(path, `${JSON.stringify(header)}\n`);
    return new SessionStore(path, cwd, [header]);
  }

  /** Create an ephemeral session that never writes a session file. */
  static inMemory(cwd = process.cwd()): SessionStore {
    return new SessionStore(null, cwd, []);
  }

  getSessionFile(): string | undefined {
    return this.sessionFile ?? undefined;
  }

  isPersisted(): boolean {
    return this.sessionFile !== null;
  }

  getCwd(): string {
    return this.cwd;
  }

  /** Session header as read from disk, or null when the file had none. */
  getHeader(): SessionHeader | null {
    return this.header;
  }

  /** Stable session id: the header id, or a generated id for fresh sessions. */
  getSessionId(): string {
    return this.sessionId;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  /** All session entries (header excluded). Returns a shallow copy. */
  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  /** Latest user-assigned session name, if any. */
  getSessionName(): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.type === "session_info") return entry.name?.trim() || undefined;
    }
    return undefined;
  }

  /**
   * Walk from an entry to the root, returning entries in path order
   * (root first). Defaults to the current leaf.
   */
  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    let currentId = fromId ?? this.leafId;
    while (currentId) {
      const entry = this.byId.get(currentId);
      if (!entry) break;
      path.push(entry);
      currentId = entry.parentId;
    }
    return path.toReversed();
  }

  /**
   * Build the LLM context (messages, thinking level, model) from the current
   * branch, resolving compaction and branch summaries along the path.
   */
  buildSessionContext(): SessionContext {
    return buildContextFromEntries(this.getBranch());
  }

  /** Append a chat message as a child of the current leaf. Returns the entry id. */
  appendMessage(message: AgentMessage): string {
    return this.appendEntry({ type: "message", message });
  }

  /** Append an extension/application data entry (never sent to the LLM). */
  appendCustomEntry(customType: string, data?: unknown): string {
    return this.appendEntry({ type: "custom", customType, data });
  }

  /** Append a custom message entry that participates in LLM context. */
  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string {
    return this.appendEntry({ type: "custom_message", customType, content, display, details });
  }

  /** Record a user-visible session name. */
  appendSessionInfo(name: string): string {
    return this.appendEntry({ type: "session_info", name });
  }

  /** Persist a compaction summary produced for this session. */
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    return this.appendEntry({
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore,
      ...(details !== undefined ? { details } : {}),
      ...(fromHook !== undefined ? { fromHook } : {}),
    });
  }

  private appendEntry(partial: PendingSessionEntry): string {
    const entry = {
      ...partial,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.persist(entry);
    return entry.id;
  }

  private persist(entry: SessionEntry): void {
    if (this.sessionFile === null) return;
    if (!this.headerOnDisk || this.rewriteBeforeAppend) {
      this.header ??= {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: this.sessionId,
        timestamp: new Date().toISOString(),
        cwd: this.cwd,
      };
      const lines = [this.header, ...this.entries].map((line) => JSON.stringify(line));
      mkdirSync(dirname(this.sessionFile), { recursive: true });
      atomicWritePrivateFile(this.sessionFile, `${lines.join("\n")}\n`);
      this.headerOnDisk = true;
      this.rewriteBeforeAppend = false;
      return;
    }
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }
}
