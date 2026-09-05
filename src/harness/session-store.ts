/**
 * mikan-owned facade over Pi's current JSONL v4 SessionRepo.
 *
 * Pi owns entry, branch, value, transaction, and storage validation. mikan
 * owns exact file paths, single-writer leases, lazy materialization, lineage
 * metadata, and the stable inspection API consumed by platform runtimes.
 * Older session generations are rejected and converted only by the offline
 * `mikan sessions migrate` command.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  branchTip,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
  insertEntry,
  JsonlSessionRepo,
  MemorySessionRepo,
  setValue,
  TODO_CONTEXT,
  uuidv7,
  value,
} from "@earendil-works/pi-agent-core";
import type {
  AgentMessage,
  Branch,
  Entry,
  JsonlSessionMetadata,
  JsonValue,
  Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { atomicWritePrivateFile } from "../utils/file-guards.js";
import type {
  SessionContext,
  SessionCreateInfo,
  SessionHeader,
  SessionInspection,
} from "./types.js";
import { CURRENT_SESSION_VERSION } from "./types.js";

interface CurrentSessionHeader {
  v: 4;
  kind: "header";
  id: string;
  storageVersion: number;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  nextSeq?: number;
}

type MikanSessionMetadata = Record<string, JsonValue>;

const MIKAN_METADATA = value<MikanSessionMetadata>("mikan", "metadata");
const activeWriterKeys = new Map<string, string>();

function canonicalSessionPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  mkdirSync(parent, { recursive: true });
  return join(realpathSync(parent), basename(absolute));
}

function sessionWriterKey(path: string): string {
  if (!existsSync(path)) return `path:${path}`;
  const stats = statSync(path);
  return `inode:${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

function isStaleClaim(key: string, claimedPath: string): boolean {
  if (!key.startsWith("inode:")) return false;
  return sessionWriterKey(claimedPath) !== key;
}

function claimWriter(key: string, path: string): void {
  const claimedPath = activeWriterKeys.get(key);
  if (claimedPath !== undefined && !isStaleClaim(key, claimedPath)) {
    throw new Error(`Session file already has an active writer: ${path}`);
  }
  activeWriterKeys.set(key, path);
}

function acquireWriter(path: string): { path: string; key: string } {
  const canonical = canonicalSessionPath(path);
  const key = sessionWriterKey(canonical);
  claimWriter(key, canonical);
  return { path: canonical, key };
}

function releaseWriter(key: string): void {
  activeWriterKeys.delete(key);
}

function promotePendingWriter(pathKey: string, path: string): string {
  const inodeKey = sessionWriterKey(path);
  if (inodeKey === pathKey) return pathKey;
  claimWriter(inodeKey, path);
  activeWriterKeys.delete(pathKey);
  return inodeKey;
}

function toDurable<T>(input: T): T {
  return input === undefined ? input : (JSON.parse(JSON.stringify(input)) as T);
}

class SessionFormatError extends Error {}

const HEADER_CHUNK_SIZE = 4096;
const MAX_HEADER_BYTES = 1024 * 1024;

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

function parseCurrentHeader(filePath: string, firstLine: string): CurrentSessionHeader {
  const trimmed = firstLine.trim();
  if (!trimmed) throw new SessionFormatError(`Session file has a blank header line: ${filePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SessionFormatError(`Session file header is not valid JSON: ${filePath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.type === "session" || (record.kind === "header" && record.version === 4)) {
    const generation = record.type === "session" ? "legacy v3" : "Pi 0.84 v4";
    throw new SessionFormatError(
      `Session file uses the ${generation} format: ${filePath}. Run \`mikan sessions migrate\` before starting this mikan version.`,
    );
  }
  if (
    record.kind !== "header" ||
    record.v !== 4 ||
    record.storageVersion !== 1 ||
    typeof record.id !== "string" ||
    typeof record.createdAt !== "number" ||
    typeof record.cwd !== "string"
  ) {
    throw new SessionFormatError(`Session file has an unrecognized header: ${filePath}`);
  }
  return parsed as CurrentSessionHeader;
}

function metadataFromHeader(header: CurrentSessionHeader, path: string): JsonlSessionMetadata {
  return {
    id: header.id,
    createdAt: header.createdAt,
    storageVersion: header.storageVersion,
    cwd: header.cwd,
    path,
    modifiedAt: 0,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(header.legacyParentSessionPath !== undefined
      ? { legacyParentSessionPath: header.legacyParentSessionPath }
      : {}),
  };
}

function parseMikanMetadata(filePath: string): MikanSessionMetadata | undefined {
  let current: MikanSessionMetadata | undefined;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (index === 0 || line.trim() === "") continue;
    let transaction: unknown;
    try {
      transaction = JSON.parse(line);
    } catch {
      if (index === lines.length - 1) break;
      continue;
    }
    const writes = Array.isArray(transaction) ? transaction : [transaction];
    for (const candidate of writes) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const write = candidate as Record<string, unknown>;
      if (write.kind !== "value" || write.namespace !== "mikan" || write.key !== "metadata") {
        continue;
      }
      if (write.op === "delete") current = undefined;
      else if (
        write.op === "set" &&
        typeof write.value === "object" &&
        write.value !== null &&
        !Array.isArray(write.value)
      ) {
        current = write.value as MikanSessionMetadata;
      }
    }
  }
  return current;
}

function fileFingerprint(path: string): string {
  const bytes = readFileSync(path);
  const fd = openSync(path, "r");
  try {
    const stats = fstatSync(fd);
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${bytes.toString("base64")}`;
  } finally {
    closeSync(fd);
  }
}

function materializePendingFile(
  path: string,
  header: CurrentSessionHeader,
  expectedFingerprint: string | null,
): void {
  const content = `${JSON.stringify(header)}\n`;
  if (expectedFingerprint === null) {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return;
  }
  const fd = openSync(path, "r+");
  try {
    const stats = fstatSync(fd);
    const bytes = Buffer.alloc(stats.size);
    readSync(fd, bytes, 0, bytes.length, 0);
    const actual = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${bytes.toString("base64")}`;
    if (actual !== expectedFingerprint) {
      throw new Error(`Session file changed before pending session materialization: ${path}`);
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function buildHeader(
  cwd: string,
  options?: SessionCreateInfo,
): { header: CurrentSessionHeader; metadata?: MikanSessionMetadata } {
  const metadata =
    options?.parentSession === undefined
      ? undefined
      : ({ parentSessionPath: options.parentSession } satisfies MikanSessionMetadata);
  return {
    header: {
      v: 4,
      kind: "header",
      id: options?.id ?? uuidv7(),
      storageVersion: 1,
      createdAt: Date.now(),
      cwd,
      ...(options?.parentSessionId !== undefined
        ? { parentSessionId: options.parentSessionId }
        : {}),
      ...(options?.parentSession !== undefined
        ? { legacyParentSessionPath: options.parentSession }
        : {}),
    },
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function headerView(header: CurrentSessionHeader, metadata?: MikanSessionMetadata): SessionHeader {
  const parentSession =
    typeof metadata?.parentSessionPath === "string"
      ? metadata.parentSessionPath
      : header.legacyParentSessionPath;
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: header.id,
    timestamp: new Date(header.createdAt).toISOString(),
    cwd: header.cwd,
    ...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
    ...(parentSession !== undefined ? { parentSession } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

async function openFileSession(
  path: string,
  header: CurrentSessionHeader,
): Promise<{ session: Session<JsonlSessionMetadata>; repo: JsonlSessionRepo }> {
  const sessionRepo = new JsonlSessionRepo({
    fileSystem: new NodeExecutionEnv({ cwd: process.cwd() }),
    sessionsRoot: dirname(path),
  });
  try {
    const session = await sessionRepo.open(metadataFromHeader(header, path), TODO_CONTEXT);
    return { session, repo: sessionRepo };
  } catch (error) {
    await sessionRepo.close(TODO_CONTEXT);
    throw error;
  }
}

async function mainBranch(session: Session, create: boolean): Promise<Branch | undefined> {
  const existing = await session.branch("main", TODO_CONTEXT);
  if (existing || !create) return existing;
  return session.createBranch("main", null, TODO_CONTEXT);
}

function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

function buildContext(entries: Entry[]): SessionContext {
  const compactionIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const visibleEntries =
    compactionIndex === -1
      ? entries
      : [entries[compactionIndex]!, ...entries.slice(compactionIndex + 1)];
  const messages: AgentMessage[] = [];
  for (const entry of visibleEntries) {
    if (entry.type === "message") {
      if (isContextMessage(entry.message)) messages.push(entry.message);
    } else if (entry.type === "compaction") {
      messages.push(
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
        ...entry.retainedTail.filter(isContextMessage),
      );
    } else if (entry.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  }
  return { messages };
}

interface LiveState {
  kind: "live";
  session: Session;
  header: CurrentSessionHeader;
  metadata?: MikanSessionMetadata;
  repo?: JsonlSessionRepo | MemorySessionRepo;
}

interface PendingState {
  kind: "pending";
  header: CurrentSessionHeader;
  metadata?: MikanSessionMetadata;
  fingerprint: string | null;
}

type StoreState = LiveState | PendingState;

class CachedSessionInspection implements SessionInspection {
  constructor(
    private readonly header: SessionHeader,
    private readonly entries: Entry[],
    private readonly name: string | undefined,
    private readonly branch: Entry[],
    private readonly context: SessionContext,
  ) {}

  getHeader(): SessionHeader {
    return structuredClone(this.header);
  }

  async getEntries(): Promise<Entry[]> {
    return structuredClone(this.entries);
  }

  async getSessionName(): Promise<string | undefined> {
    return this.name;
  }

  async getBranch(fromId?: string): Promise<Entry[]> {
    if (fromId === undefined) return structuredClone(this.branch);
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const result: Entry[] = [];
    let current = byId.get(fromId);
    while (current) {
      result.push(current);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return result.toReversed();
  }

  async buildSessionContext(): Promise<SessionContext> {
    return structuredClone(this.context);
  }
}

export class SessionStore implements SessionInspection {
  private mutationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closed = false;

  private constructor(
    private readonly sessionFile: string | null,
    private readonly cwd: string,
    private state: StoreState,
    private writerKey: string | null,
  ) {}

  static async open(path: string, cwdOverride?: string): Promise<SessionStore> {
    const writer = acquireWriter(path);
    const writerPath = writer.path;
    try {
      if (!existsSync(writerPath)) {
        const cwd = cwdOverride ?? process.cwd();
        const built = buildHeader(cwd);
        return new SessionStore(
          writerPath,
          cwd,
          { kind: "pending", ...built, fingerprint: null },
          writer.key,
        );
      }
      const firstLine = readHeaderLine(writerPath);
      if (firstLine.trim().length === 0) {
        const cwd = cwdOverride ?? process.cwd();
        const built = buildHeader(cwd);
        return new SessionStore(
          writerPath,
          cwd,
          { kind: "pending", ...built, fingerprint: fileFingerprint(writerPath) },
          writer.key,
        );
      }
      const header = parseCurrentHeader(writerPath, firstLine);
      const metadata = parseMikanMetadata(writerPath);
      const opened = await openFileSession(writerPath, header);
      return new SessionStore(
        writerPath,
        cwdOverride ?? header.cwd,
        { kind: "live", header, metadata, ...opened },
        writer.key,
      );
    } catch (error) {
      releaseWriter(writer.key);
      throw error;
    }
  }

  static async inspect(path: string): Promise<SessionInspection> {
    const resolvedPath = canonicalSessionPath(path);
    const snapshotDir = mkdtempSync(join(tmpdir(), "mikan-session-inspect-"));
    const snapshotPath = join(snapshotDir, basename(resolvedPath));
    let opened: Awaited<ReturnType<typeof openFileSession>> | undefined;
    try {
      writeFileSync(snapshotPath, readFileSync(resolvedPath), { mode: 0o600, flag: "wx" });
      const header = parseCurrentHeader(resolvedPath, readHeaderLine(snapshotPath));
      const metadata = parseMikanMetadata(snapshotPath);
      opened = await openFileSession(snapshotPath, header);
      const entries = await opened.session.findEntries({ order: "asc" }, TODO_CONTEXT);
      const name = await opened.session.getName(TODO_CONTEXT);
      const branchObject = await mainBranch(opened.session, false);
      const branch = branchObject
        ? await branchObject.findEntries({ order: "oldestFirst" }, TODO_CONTEXT)
        : [];
      const context = buildContext(branch);
      return new CachedSessionInspection(
        headerView(header, metadata),
        entries,
        name,
        branch,
        context,
      );
    } finally {
      if (opened) {
        await opened.session.close(TODO_CONTEXT);
        await opened.repo.close(TODO_CONTEXT);
      }
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  static async create(
    path: string,
    cwd: string,
    options?: SessionCreateInfo,
  ): Promise<SessionStore> {
    const writer = acquireWriter(path);
    const writerPath = writer.path;
    let leaseKey = writer.key;
    let opened: Awaited<ReturnType<typeof openFileSession>> | undefined;
    try {
      const built = buildHeader(cwd, options);
      mkdirSync(dirname(writerPath), { recursive: true });
      writeFileSync(writerPath, `${JSON.stringify(built.header)}\n`, { mode: 0o600, flag: "wx" });
      leaseKey = promotePendingWriter(leaseKey, writerPath);
      opened = await openFileSession(writerPath, built.header);
      if (built.metadata) {
        await opened.session.setValue(MIKAN_METADATA, built.metadata, TODO_CONTEXT);
      }
      return new SessionStore(writerPath, cwd, { kind: "live", ...built, ...opened }, leaseKey);
    } catch (error) {
      if (opened) {
        await opened.session.close(TODO_CONTEXT).catch(() => undefined);
        await opened.repo.close(TODO_CONTEXT).catch(() => undefined);
      }
      releaseWriter(leaseKey);
      throw error;
    }
  }

  static readHeader(path: string): SessionHeader | null {
    let firstLine: string;
    try {
      firstLine = readHeaderLine(path);
    } catch {
      return null;
    }
    if (firstLine.trim().length === 0) return null;
    try {
      const header = parseCurrentHeader(path, firstLine);
      return headerView(header, parseMikanMetadata(path));
    } catch (error) {
      if (error instanceof SessionFormatError && /legacy v3|Pi 0\.84 v4/.test(error.message)) {
        throw error;
      }
      return null;
    }
  }

  static writeHeaderFile(path: string, cwd: string, options?: SessionCreateInfo): void {
    mkdirSync(dirname(path), { recursive: true });
    const built = buildHeader(cwd, options);
    atomicWritePrivateFile(path, `${JSON.stringify(built.header)}\n`);
  }

  static inMemory(cwd = process.cwd()): SessionStore {
    const built = buildHeader(cwd);
    return new SessionStore(null, cwd, { kind: "pending", ...built, fingerprint: null }, null);
  }

  getSessionFile(): string | undefined {
    this.assertOpen();
    return this.sessionFile ?? undefined;
  }

  isPersisted(): boolean {
    this.assertOpen();
    return this.sessionFile !== null;
  }

  getCwd(): string {
    this.assertOpen();
    return this.cwd;
  }

  getHeader(): SessionHeader {
    this.assertOpen();
    return headerView(this.state.header, this.state.metadata);
  }

  getSessionId(): string {
    this.assertOpen();
    return this.state.header.id;
  }

  async getLeafId(): Promise<string | null> {
    this.assertOpen();
    if (this.state.kind === "pending") return null;
    return (await mainBranch(this.state.session, false))?.getTipId(TODO_CONTEXT) ?? null;
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    this.assertOpen();
    if (this.state.kind === "pending") return undefined;
    return this.state.session.getEntry(id, TODO_CONTEXT);
  }

  async getEntries(): Promise<Entry[]> {
    this.assertOpen();
    if (this.state.kind === "pending") return [];
    return this.state.session.findEntries({ order: "asc" }, TODO_CONTEXT);
  }

  async getSessionName(): Promise<string | undefined> {
    this.assertOpen();
    if (this.state.kind === "pending") return undefined;
    return this.state.session.getName(TODO_CONTEXT);
  }

  async getBranch(fromId?: string): Promise<Entry[]> {
    this.assertOpen();
    if (this.state.kind === "pending") return [];
    if (fromId !== undefined) {
      return this.state.session.scanBranch({ start: fromId, order: "oldestFirst" }, TODO_CONTEXT);
    }
    const branchObject = await mainBranch(this.state.session, false);
    return branchObject ? branchObject.findEntries({ order: "oldestFirst" }, TODO_CONTEXT) : [];
  }

  async buildSessionContext(): Promise<SessionContext> {
    return buildContext(await this.getBranch());
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    return this.mutate(async () => {
      const branchObject = await mainBranch((await this.live()).session, true);
      if (!branchObject) throw new Error("Failed to create main session branch");
      return branchObject.appendMessage(toDurable(message), TODO_CONTEXT);
    });
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
    return this.mutate(async () => {
      const branchObject = await mainBranch((await this.live()).session, true);
      if (!branchObject) throw new Error("Failed to create main session branch");
      return branchObject.appendCustomEntry(customType, toDurable(data) as JsonValue, TODO_CONTEXT);
    });
  }

  async appendCustomMessageEntry(
    customType: string,
    content: string | Array<TextContent | ImageContent>,
    display: boolean,
    details?: unknown,
  ): Promise<string> {
    return this.appendMessage(
      toDurable(createCustomMessage(customType, content, display, details, Date.now())),
    );
  }

  async setSessionName(name: string): Promise<void> {
    await this.mutate(async () =>
      (await this.live()).session.setName(name.trim() || undefined, TODO_CONTEXT),
    );
  }

  async appendCompaction(
    summary: string,
    retainedTail: AgentMessage[],
    tokensBefore: number,
    details?: unknown,
  ): Promise<string> {
    return this.mutate(async () => {
      const { session } = await this.live();
      const id = session.idGenerator.next();
      await session.mutate(async (mutator, context) => {
        const currentTip = await mutator.getValue(branchTip("main"), context);
        await mutator.commit(
          [
            insertEntry({
              type: "compaction",
              id,
              parentId: currentTip?.value ?? null,
              summary,
              retainedTail: toDurable(retainedTail),
              tokensBefore,
              fromHook: false,
              ...(details !== undefined ? { details: toDurable(details) as JsonValue } : {}),
            }),
            setValue(branchTip("main"), id),
          ],
          context,
        );
      }, TODO_CONTEXT);
      return id;
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.mutationTail
      .then(async () => {
        if (this.state.kind !== "live") return;
        try {
          await this.state.session.close(TODO_CONTEXT);
        } finally {
          await this.state.repo?.close(TODO_CONTEXT);
        }
      })
      .finally(() => {
        if (this.writerKey !== null) releaseWriter(this.writerKey);
      });
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SessionStore is closed");
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async live(): Promise<LiveState> {
    if (this.state.kind === "live") return this.state;
    const pending = this.state;
    const sessionFile = this.sessionFile;
    if (sessionFile === null) {
      const repo = new MemorySessionRepo();
      const session = await repo.create(
        {
          id: pending.header.id,
          ...(pending.header.parentSessionId !== undefined
            ? { parentSessionId: pending.header.parentSessionId }
            : {}),
        },
        TODO_CONTEXT,
      );
      const live: LiveState = {
        kind: "live",
        header: pending.header,
        metadata: pending.metadata,
        session,
        repo,
      };
      this.state = live;
      return live;
    }
    materializePendingFile(sessionFile, pending.header, pending.fingerprint);
    if (this.writerKey === null) throw new Error("Pending session must have a writer lease");
    this.writerKey = promotePendingWriter(this.writerKey, sessionFile);
    const opened = await openFileSession(sessionFile, pending.header);
    if (pending.metadata) {
      await opened.session.setValue(MIKAN_METADATA, pending.metadata, TODO_CONTEXT);
    }
    const live: LiveState = {
      kind: "live",
      header: pending.header,
      metadata: pending.metadata,
      ...opened,
    };
    this.state = live;
    return live;
  }
}
