/**
 * mikan-owned session storage facade over pi-agent-core's v4 sessions.
 *
 * Sessions are pi v4 JSONL files: a `{"kind":"header","version":4,...}` line
 * followed by mutation lines (entries, lane pointers, facts, lane records).
 * pi's `Session`/`JsonlSessionStorage` own the format, tree validation, and
 * torn-tail repair; this facade owns mikan's concerns only: session files
 * live at mikan-chosen paths (session-key layout), mikan header extras ride
 * in the v4 header `metadata`, and a missing file behaves as an empty
 * session whose header materializes on the first append.
 *
 * v3 files (the pre-0.84 layout) are not readable at runtime: `open` throws
 * an actionable error pointing at the `mikan sessions migrate` script.
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  buildSessionContext as buildContextFromEntries,
  createCustomMessage,
  InMemorySessionStorage,
  JsonlSessionRepo,
  Session,
  uuidv7,
} from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  Entry,
  JsonlSessionMetadata,
  JsonlV4Header,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { atomicWritePrivateFile } from "../utils/file-guards.js";
import { CURRENT_SESSION_VERSION, type SessionContext, type SessionHeader } from "./types.js";

let sharedRepo: JsonlSessionRepo | undefined;

/**
 * Drop undefined-valued properties before durable persistence. pi's agent
 * loop builds messages with explicit `details: undefined` / `usage: undefined`
 * (e.g. tool results from tools that return only `content`), which pi's own
 * v4 durable-payload validator rejects; persistence is a value boundary, so
 * a JSON round-trip matches the validator's semantics exactly.
 */
function toDurable<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function repo(): JsonlSessionRepo {
  // The repo is only used to open sessions at explicit paths; its
  // sessionsRoot layout is never consulted, so one shared instance is fine.
  sharedRepo ??= new JsonlSessionRepo({
    fs: new NodeExecutionEnv({ cwd: process.cwd() }),
    sessionsRoot: process.cwd(),
  });
  return sharedRepo;
}

class SessionFormatError extends Error {}

const HEADER_CHUNK_SIZE = 4096;
const MAX_HEADER_BYTES = 1024 * 1024;

/** Read only the first JSONL line rather than loading the complete session. */
function readHeaderLine(filePath: string): string {
  const fd = openSync(filePath, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < MAX_HEADER_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(HEADER_CHUNK_SIZE, MAX_HEADER_BYTES - total));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      const newline = data.indexOf(0x0a);
      chunks.push(newline < 0 ? data : data.subarray(0, newline));
      total += newline < 0 ? bytesRead : newline;
      if (newline >= 0) break;
    }
  } finally {
    closeSync(fd);
  }
  if (total >= MAX_HEADER_BYTES) {
    throw new SessionFormatError(
      `Session file header exceeds ${MAX_HEADER_BYTES} bytes: ${filePath}`,
    );
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Parse the first line of a session file into a v4 header, or explain why not. */
function parseV4Header(filePath: string, firstLine: string): JsonlV4Header {
  firstLine = firstLine.trim();
  if (!firstLine) throw new SessionFormatError(`Session file has a blank header line: ${filePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new SessionFormatError(`Session file header is not valid JSON: ${filePath}`);
  }
  const record = parsed as {
    kind?: unknown;
    type?: unknown;
    version?: unknown;
    id?: unknown;
  };
  if (record.type === "session") {
    throw new SessionFormatError(
      `Session file uses the legacy v3 format: ${filePath}. Run \`mikan sessions migrate\` before starting this mikan version.`,
    );
  }
  if (record.kind !== "header" || record.version !== 4 || typeof record.id !== "string") {
    throw new SessionFormatError(`Session file has an unrecognized header: ${filePath}`);
  }
  return parsed as JsonlV4Header;
}

function metadataFromHeader(header: JsonlV4Header, path: string): JsonlSessionMetadata {
  return {
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    path,
    modifiedAt: 0,
    sourceFormat: 4,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.legacyParentSessionPath !== undefined
      ? { legacyParentSessionPath: header.legacyParentSessionPath }
      : {}),
    ...(header.metadata !== undefined ? { metadata: header.metadata } : {}),
  };
}

export interface SessionCreateInfo {
  id?: string;
  parentSession?: string;
  parentSessionId?: string;
}

function buildHeader(cwd: string, options?: SessionCreateInfo): JsonlV4Header {
  return {
    kind: "header",
    version: 4,
    id: options?.id ?? uuidv7(),
    createdAt: Date.now(),
    cwd,
    ...(options?.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    // The v3 parent *path* has no dedicated v4 slot when the id is known;
    // preserve it in metadata so lineage debugging keeps working.
    ...(options?.parentSession !== undefined
      ? { metadata: { parentSessionPath: options.parentSession } }
      : {}),
  };
}

function headerView(header: JsonlV4Header): SessionHeader {
  const metadata = header.metadata as Record<string, unknown> | undefined;
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: header.id,
    timestamp: new Date(header.createdAt).toISOString(),
    cwd: header.cwd,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(typeof metadata?.parentSessionPath === "string"
      ? { parentSession: metadata.parentSessionPath }
      : {}),
    ...(header.legacyParentSessionPath !== undefined && metadata?.parentSessionPath === undefined
      ? { parentSession: header.legacyParentSessionPath }
      : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

type StoreState =
  | { kind: "live"; session: Session; header: JsonlV4Header }
  | { kind: "pending"; header: JsonlV4Header };

/**
 * Async session store over one pi v4 JSONL file at a mikan-chosen path.
 *
 * A missing or empty file opens as an empty session; the header (and file)
 * materialize on the first append. Files with content must carry a valid
 * v4 header — v3 files throw with a pointer at the migration script.
 */
export class SessionStore {
  private readonly sessionFile: string | null;
  private readonly cwd: string;
  private state: StoreState;

  private constructor(sessionFile: string | null, cwd: string, state: StoreState) {
    this.sessionFile = sessionFile === null ? null : resolve(sessionFile);
    this.cwd = cwd;
    this.state = state;
  }

  /**
   * Open a session file. Missing and empty files start an empty session
   * whose header is written on the first append.
   * @param cwdOverride Working directory override; defaults to the header cwd.
   */
  static async open(path: string, cwdOverride?: string): Promise<SessionStore> {
    if (!existsSync(path)) {
      const cwd = cwdOverride ?? process.cwd();
      return new SessionStore(path, cwd, {
        kind: "pending",
        header: buildHeader(cwd),
      });
    }
    const firstLine = readHeaderLine(path);
    if (firstLine.trim().length === 0) {
      const cwd = cwdOverride ?? process.cwd();
      return new SessionStore(path, cwd, {
        kind: "pending",
        header: buildHeader(cwd),
      });
    }
    const header = parseV4Header(path, firstLine);
    const session = await repo().open(metadataFromHeader(header, resolve(path)));
    return new SessionStore(resolve(path), cwdOverride ?? header.cwd, {
      kind: "live",
      session: session,
      header,
    });
  }

  /** Create a new session file with a fresh header, replacing any existing file. */
  static async create(
    path: string,
    cwd: string,
    options?: SessionCreateInfo,
  ): Promise<SessionStore> {
    const header = buildHeader(cwd, options);
    mkdirSync(dirname(path), { recursive: true });
    atomicWritePrivateFile(path, `${JSON.stringify(header)}\n`);
    const session = await repo().open(metadataFromHeader(header, resolve(path)));
    return new SessionStore(resolve(path), cwd, {
      kind: "live",
      session: session,
      header,
    });
  }

  /**
   * Synchronously read a session file's header without opening the session.
   * Returns null for missing, empty, or unreadable files; throws only for
   * v3 files so callers surface the migration requirement.
   */
  static readHeader(path: string): SessionHeader | null {
    let firstLine: string;
    try {
      firstLine = readHeaderLine(path);
    } catch {
      return null;
    }
    if (firstLine.trim().length === 0) return null;
    try {
      return headerView(parseV4Header(path, firstLine));
    } catch (error) {
      if (error instanceof SessionFormatError && /legacy v3/.test(error.message)) throw error;
      return null;
    }
  }

  /**
   * Synchronously write a fresh header-only session file, replacing any
   * existing file. The session is opened later via {@link SessionStore.open}.
   */
  static writeHeaderFile(path: string, cwd: string, options?: SessionCreateInfo): void {
    mkdirSync(dirname(path), { recursive: true });
    atomicWritePrivateFile(path, `${JSON.stringify(buildHeader(cwd, options))}\n`);
  }

  /** Create an ephemeral session that never writes a session file. */
  static inMemory(cwd = process.cwd()): SessionStore {
    const header = buildHeader(cwd);
    const storage = new InMemorySessionStorage({
      id: header.id,
      createdAt: header.createdAt,
    });
    const session = new Session(storage);
    return new SessionStore(null, cwd, { kind: "live", session, header });
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

  /** Compatibility header view for callers that read mikan session lineage. */
  getHeader(): SessionHeader {
    return headerView(this.state.header);
  }

  /** Stable session id: the header id, or a generated id for fresh sessions. */
  getSessionId(): string {
    return this.state.header.id;
  }

  async getLeafId(): Promise<string | null> {
    if (this.state.kind === "pending") return null;
    return this.state.session.getLeafId();
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    if (this.state.kind === "pending") return undefined;
    return this.state.session.getEntry(id);
  }

  /** All session entries in append order. */
  async getEntries(): Promise<Entry[]> {
    if (this.state.kind === "pending") return [];
    return this.state.session.findEntries({ order: "oldestFirst" });
  }

  /** Latest user-assigned session name, if any. */
  async getSessionName(): Promise<string | undefined> {
    if (this.state.kind === "pending") return undefined;
    return this.state.session.getName();
  }

  /**
   * Walk from an entry to the root, returning entries in path order
   * (root first). Defaults to the current leaf.
   */
  async getBranch(fromId?: string): Promise<Entry[]> {
    if (this.state.kind === "pending") return [];
    return this.state.session.findEntriesOnBranch({
      order: "oldestFirst",
      ...(fromId !== undefined ? { start: fromId } : {}),
    });
  }

  /**
   * Build the LLM context (messages, thinking level, model) from the current
   * branch, resolving compaction and branch summaries along the path.
   */
  async buildSessionContext(): Promise<SessionContext> {
    return buildContextFromEntries(await this.getBranch());
  }

  /** Append a chat message as a child of the current leaf. Returns the entry id. */
  async appendMessage(message: AgentMessage): Promise<string> {
    return (await this.live()).appendMessage(toDurable(message));
  }

  /** Append an extension/application data entry (never sent to the LLM). */
  async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
    return (await this.live()).appendCustomEntry(customType, toDurable(data));
  }

  /** Append a custom message that participates in LLM context. */
  async appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): Promise<string> {
    return (await this.live()).appendMessage(
      toDurable(createCustomMessage(customType, content, display, details, Date.now())),
    );
  }

  /** Record a user-visible session name. */
  async setSessionName(name: string): Promise<void> {
    await (await this.live()).setName(name.trim() || undefined);
  }

  /** Persist a compaction summary produced for this session. */
  async appendCompaction(
    summary: string,
    retainedTail: AgentMessage[],
    tokensBefore: number,
    details?: unknown,
  ): Promise<string> {
    const session = await this.live();
    const entry = await session.appendEntry(
      {
        type: "compaction",
        id: session.idGenerator.next(),
        summary,
        retainedTail: toDurable(retainedTail),
        tokensBefore,
        ...(details !== undefined ? { details: toDurable(details) } : {}),
      },
      "main",
    );
    return entry.id;
  }

  /** Materialize the session file (when persisted) and return the live session. */
  private async live(): Promise<Session> {
    if (this.state.kind === "live") return this.state.session;
    const header = this.state.header;
    const sessionFile = this.sessionFile;
    if (sessionFile === null) throw new Error("Pending session must have a session file");
    mkdirSync(dirname(sessionFile), { recursive: true });
    atomicWritePrivateFile(sessionFile, `${JSON.stringify(header)}\n`);
    const session = await repo().open(metadataFromHeader(header, sessionFile));
    this.state = { kind: "live", session, header };
    return session;
  }
}
