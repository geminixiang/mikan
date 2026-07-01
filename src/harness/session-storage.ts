import {
  SessionError,
  uuidv7,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import * as log from "../log.js";
import { isRecord, readTextFileIfExists } from "../utils/file-guards.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";
import type { MikanSessionHeader } from "../sessions/types.js";

const CURRENT_SESSION_VERSION = 3;

export interface MikanSessionMetadata extends SessionMetadata {
  cwd: string;
  path: string;
  parentSessionPath?: string;
}

export type RawSessionHeader = MikanSessionHeader & {
  type: "session";
  id: string;
  timestamp: string;
};

function isSessionHeader(value: unknown): value is RawSessionHeader {
  return (
    isRecord(value) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string"
  );
}

function isSessionTreeEntry(value: unknown): value is SessionTreeEntry {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.id === "string" &&
    "parentId" in value &&
    typeof value.timestamp === "string"
  );
}

function generateEntryId(byId: Map<string, SessionTreeEntry>): string {
  // randomUUID (v4), not uuidv7: v7's leading bytes are a millisecond timestamp,
  // so truncating it to 8 hex chars can collide across independently-created
  // session files generated within the same millisecond (e.g. a channel session
  // and a thread session bootstrapped back-to-back), corrupting id-based
  // cross-session matching. v4 is fully random, so an 8-char slice is safe.
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return randomUUID();
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

function toMetadata(sessionFile: string, header: RawSessionHeader): MikanSessionMetadata {
  return {
    id: header.id,
    createdAt: header.timestamp,
    cwd: header.cwd ?? "",
    path: sessionFile,
    parentSessionPath: header.parentSession,
  };
}

interface ParsedSessionFile {
  header: RawSessionHeader;
  entries: SessionTreeEntry[];
}

/**
 * Parses mikan's existing on-disk session format: a header line followed by
 * newline-delimited session-tree entries. Returns null when the file has no
 * usable header (missing, empty, or corrupted first line) so callers can fall
 * back to starting a fresh session, matching pi-coding-agent's own recovery
 * behavior — but unlike pi-coding-agent, a corrupted *entry* line (not the
 * header) is skipped with a warning instead of aborting the whole load, since
 * this is real chat history and losing only the unreadable line is preferable
 * to discarding an entire conversation.
 */
function parseSessionFile(raw: string, sessionFile: string): ParsedSessionFile | null {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch (err) {
    log.logWarning(
      `Corrupted session header, starting fresh: ${sessionFile}`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (!isSessionHeader(header)) {
    log.logWarning(`Missing or invalid session header, starting fresh: ${sessionFile}`);
    return null;
  }

  const entries: SessionTreeEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!isSessionTreeEntry(parsed)) {
        throw new Error("not a session entry");
      }
      entries.push(parsed);
    } catch (err) {
      log.logWarning(
        `Skipping corrupted session entry (line ${i + 1}): ${sessionFile}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { header, entries };
}

/**
 * mikan-owned SessionStorage implementation, byte-compatible with the JSONL
 * format previously written/read by pi-coding-agent's SessionManager: a
 * `{type:"session",version,id,timestamp,cwd,parentSession?}` header line
 * followed by newline-delimited session-tree entries. Existing production
 * session files are readable/writable without migration.
 *
 * Persists eagerly (no delayed-write gate): by the time this class opens or
 * creates a file, mikan's own `src/sessions/store.ts` layer has always
 * already ensured the file exists with a valid header, so there is no
 * "no assistant reply yet" empty-file case to guard against here.
 */
export class MikanSessionStorage implements SessionStorage<MikanSessionMetadata> {
  private readonly entries: SessionTreeEntry[] = [];
  private readonly byId = new Map<string, SessionTreeEntry>();
  private readonly labelsById = new Map<string, string>();
  private leafId: string | null = null;
  private readonly metadata: MikanSessionMetadata;

  private constructor(
    private readonly sessionFile: string,
    private rawHeader: RawSessionHeader,
    entries: SessionTreeEntry[],
  ) {
    this.metadata = toMetadata(sessionFile, rawHeader);
    for (const entry of entries) this.indexEntry(entry);
  }

  /** Open an existing session file, or create a fresh one if missing/corrupted. */
  static open(sessionFile: string, cwd: string): MikanSessionStorage {
    const raw = readTextFileIfExists(sessionFile);
    if (raw !== undefined) {
      const parsed = parseSessionFile(raw, sessionFile);
      if (parsed) return new MikanSessionStorage(sessionFile, parsed.header, parsed.entries);
    }
    return MikanSessionStorage.create(sessionFile, cwd);
  }

  /**
   * Open an existing session file strictly read-only: throws if the file is
   * missing or has no valid header, and never creates or rewrites anything.
   * Used by read-only consumers (e.g. the session web viewer) that must not
   * materialize a fresh session as a side effect of inspecting a bad file.
   */
  static openReadOnly(sessionFile: string): MikanSessionStorage {
    const raw = readTextFileIfExists(sessionFile);
    if (raw === undefined) {
      throw new Error(`Session file does not exist: ${sessionFile}`);
    }
    const parsed = parseSessionFile(raw, sessionFile);
    if (!parsed) {
      throw new Error(`Session file is corrupted: ${sessionFile}`);
    }
    return new MikanSessionStorage(sessionFile, parsed.header, parsed.entries);
  }

  /**
   * Read-only, side-effect-free peek at a session file's header, or null if the
   * file is missing/unreadable/has no valid header. Unlike `open()`, never
   * creates a file — used by metadata checks that must not materialize sessions
   * as a side effect of merely inspecting them.
   */
  static peekHeader(sessionFile: string): RawSessionHeader | null {
    let raw: string | undefined;
    try {
      raw = readTextFileIfExists(sessionFile);
    } catch {
      return null;
    }
    if (raw === undefined) return null;
    const firstLine = raw.split("\n").find((line) => line.trim());
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine);
      return isSessionHeader(header) ? header : null;
    } catch {
      return null;
    }
  }

  /** Create a brand-new session file with a fresh header, writing it immediately. */
  static create(
    sessionFile: string,
    cwd: string,
    options?: { sessionId?: string; parentSession?: string },
  ): MikanSessionStorage {
    const header: RawSessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: options?.sessionId ?? uuidv7(),
      timestamp: new Date().toISOString(),
      cwd,
      parentSession: options?.parentSession,
    };
    const dir = dirname(sessionFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    atomicWritePrivateFile(sessionFile, `${JSON.stringify(header)}\n`);
    return new MikanSessionStorage(sessionFile, header, []);
  }

  /** Raw header fields not modeled by pi-agent-core's SessionMetadata (e.g. `source`). */
  getRawHeader(): RawSessionHeader {
    return this.rawHeader;
  }

  getSessionFile(): string {
    return this.sessionFile;
  }

  private indexEntry(entry: SessionTreeEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    if (entry.type === "label") {
      const label = entry.label?.trim();
      if (label) this.labelsById.set(entry.targetId, label);
      else this.labelsById.delete(entry.targetId);
    }
    this.leafId = leafIdAfterEntry(entry);
  }

  async getMetadata(): Promise<MikanSessionMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    return this.leafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    this.leafId = leafId;
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.byId);
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.indexEntry(entry);
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.byId.get(id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.entries.filter(
      (entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type,
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (!current.parentId) break;
      const parent: SessionTreeEntry | undefined = this.byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return [...this.entries];
  }
}
