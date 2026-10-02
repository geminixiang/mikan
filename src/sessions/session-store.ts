import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  AssistantEntry,
  CompactionEntry,
  Harness,
  LiveDoc,
  MemoryStorage,
  ToolResultEntry,
  UserEntry,
  createRegistry,
  defineDoc,
  defineEntry,
  type Conversation,
  type EntryRecord,
  type HarnessOptions,
  type HarnessSettings,
  type JsonObject,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { atomicWritePrivateFile } from "../file-guards.js";
import type {
  SessionContext,
  SessionCreateInfo,
  SessionEntry,
  SessionHeader,
  SessionInspection,
  SessionRunRecord,
  SessionRunStatus,
} from "./types.js";
import { loadMcpTools, formatMcpServerInstructions } from "../harness/mcp.js";
import type { McpServerConfig, McpToolsResult } from "../harness/types.js";
import * as log from "../log.js";
import { compactionSummaryOf, wrapCompactionSummary } from "./compaction-summary.js";
import { errorMessage, isRecord } from "../unknown-values.js";

const context = BACKGROUND_CONTEXT;
const ENTRY_PAGE_SIZE = 500;

type SessionDocState = Partial<{
  name: string;
  run: Partial<SessionRunRecord>;
}>;

const SessionDoc = defineDoc<SessionDocState>({
  kind: "mikan.session",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

const CustomSessionEntry = defineEntry<{
  customType: string;
  data: JsonValue;
  timestamp: number;
}>("mikan.custom");

export interface SessionHarnessBinding {
  models: Models;
  env?: HarnessOptions["env"];
  settings?: HarnessSettings;
  onReport?: (error: unknown) => void;
}

export interface AttachedSessionHarness {
  harness: Harness;
  root: Conversation;
  registry: Registry;
}

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

function toJson(input: unknown): JsonValue {
  if (input === undefined) return null;
  const copy: JsonValue = JSON.parse(JSON.stringify(input));
  return copy;
}

function durableMessage(message: Message): Message {
  const copy: Message = JSON.parse(JSON.stringify(message));
  return copy;
}

class SessionFormatError extends Error {}

export function sessionStorageDir(sessionFile: string): string {
  const stem = sessionFile.endsWith(".jsonl")
    ? sessionFile.slice(0, -".jsonl".length)
    : sessionFile;
  return `${stem}.durable`;
}

function readHeader(filePath: string): SessionHeader {
  const line = readFileSync(filePath, "utf-8").split("\n", 1)[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new SessionFormatError(`Session file header is not valid JSON: ${filePath}`);
  }
  if (!isRecord(parsed)) {
    throw new SessionFormatError(`Session file has an unrecognized header: ${filePath}`);
  }
  const { id, createdAt, parentSessionId, source } = parsed;
  if (typeof id !== "string" || typeof createdAt !== "number") {
    throw new SessionFormatError(`Session file has an unrecognized header: ${filePath}`);
  }
  return {
    id,
    createdAt,
    parentSessionId: typeof parentSessionId === "string" ? parentSessionId : undefined,
    source: isRecord(source) ? toJsonObject(source) : undefined,
  };
}

function toJsonObject(input: Record<string, unknown>): JsonObject {
  const copy: JsonObject = JSON.parse(JSON.stringify(input));
  return copy;
}

function buildHeader(options?: SessionCreateInfo): SessionHeader {
  return {
    id: options?.id ?? randomUUID(),
    createdAt: Date.now(),
    parentSessionId: options?.parentSessionId,
    source: options?.source,
  };
}

function writeHeader(path: string, header: SessionHeader): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWritePrivateFile(path, `${JSON.stringify(header)}\n`);
}

async function openPrivateJsonlStorage(directory: string): Promise<Storage> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return openNodeJsonlStorage(directory, context);
}

function messageTimestamp(message: Message | undefined): number {
  return message && "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : 0;
}

function contentText(message: Message | undefined): string {
  if (!message || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toSessionEntry(record: EntryRecord, sessionId: string): SessionEntry | undefined {
  const id = `${sessionId}:${record.id}`;
  const message = record.model?.[0];
  if (UserEntry.is(record) || AssistantEntry.is(record) || ToolResultEntry.is(record)) {
    if (!message) return undefined;
    return { type: "message", id, timestamp: messageTimestamp(message), message };
  }
  if (CompactionEntry.is(record)) {
    return {
      type: "compaction",
      id,
      timestamp: messageTimestamp(message),
      summary: (message && compactionSummaryOf(message)) ?? contentText(message),
    };
  }
  if (CustomSessionEntry.is(record)) {
    return {
      type: "custom",
      id,
      timestamp: record.data.timestamp,
      customType: record.data.customType,
      data: record.data.data ?? undefined,
    };
  }
  return undefined;
}

function toSessionEntries(records: readonly EntryRecord[], sessionId: string): SessionEntry[] {
  return records.flatMap((record) => toSessionEntry(record, sessionId) ?? []);
}

async function readEntries(root: Conversation, sessionId: string): Promise<SessionEntry[]> {
  const records: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await root.entries({}, ENTRY_PAGE_SIZE, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return toSessionEntries(records.toReversed(), sessionId);
}

async function readContext(root: Conversation): Promise<SessionContext> {
  const view = await root.context(context);
  const messages: AgentMessage[] = view.messages
    .filter((message) => message.role !== "system")
    .map(durableMessage);
  return { messages };
}

function lateBoundOptions(
  registry: Registry,
  binding: () => SessionHarnessBinding | undefined,
): HarnessOptions {
  const settings = (): HarnessSettings | undefined => binding()?.settings;
  const models = new Proxy({} as Models, {
    get: (_target, property) => {
      const bound = binding()?.models;
      if (!bound) throw new Error("Session has no model binding; start a run to use the model");
      const value = Reflect.get(bound, property, bound) as unknown;
      return typeof value === "function" ? value.bind(bound) : value;
    },
  });
  return {
    models,
    registry,
    settings: {
      get extensions() {
        return settings()?.extensions;
      },
      get stream() {
        return settings()?.stream;
      },
      get retry() {
        return settings()?.retry;
      },
      get compaction() {
        return settings()?.compaction;
      },
      get toolExecution() {
        return settings()?.toolExecution;
      },
      get steeringMode() {
        return settings()?.steeringMode;
      },
      get followUpMode() {
        return settings()?.followUpMode;
      },
    },
    env: (target, envContext) => binding()?.env?.(target, envContext),
    onReport: (error) => {
      const report = binding()?.onReport;
      if (report) report(error);
      else log.logWarning("Durable harness report", errorMessage(error));
    },
  };
}

async function withSessionSnapshot<T>(
  path: string,
  read: (root: Conversation | undefined, harness: Harness | undefined) => Promise<T>,
): Promise<T> {
  const storageDir = sessionStorageDir(canonicalSessionPath(path));
  if (!existsSync(storageDir)) return read(undefined, undefined);
  const dir = mkdtempSync(join(tmpdir(), "mikan-session-inspect-"));
  let harness: Harness | undefined;
  try {
    const snapshot = join(dir, "storage");
    cpSync(storageDir, snapshot, { recursive: true, verbatimSymlinks: true });
    const storage = await openNodeJsonlStorage(snapshot, context);
    harness = await Harness.open(
      storage,
      lateBoundOptions(createRegistry(), () => undefined),
      context,
    );
    return await read(await harness.root(context), harness);
  } finally {
    try {
      await harness?.close(context);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

interface LiveState {
  kind: "live";
  header: SessionHeader;
  harness: Harness;
  root: Conversation;
}

interface PendingState {
  kind: "pending";
  header: SessionHeader;
}

type StoreState = LiveState | PendingState;

class CachedSessionInspection implements SessionInspection {
  constructor(
    private readonly header: SessionHeader,
    private readonly entries: SessionEntry[],
    private readonly name: string | undefined,
    private readonly sessionContext: SessionContext,
  ) {}

  getHeader(): SessionHeader {
    return structuredClone(this.header);
  }

  async getEntries(): Promise<SessionEntry[]> {
    return structuredClone(this.entries);
  }

  async getSessionName(): Promise<string | undefined> {
    return this.name;
  }

  async buildSessionContext(): Promise<SessionContext> {
    return structuredClone(this.sessionContext);
  }
}

export class SessionStore implements SessionInspection {
  private mcp: McpToolsResult | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private binding: SessionHarnessBinding | undefined;
  private readonly registry: Registry = createRegistry();

  private constructor(
    private readonly sessionFile: string | null,
    private state: StoreState,
    private writerKey: string | null,
  ) {}

  static async open(path: string): Promise<SessionStore> {
    const writer = acquireWriter(path);
    const writerPath = writer.path;
    try {
      if (!existsSync(writerPath)) {
        return new SessionStore(writerPath, { kind: "pending", header: buildHeader() }, writer.key);
      }
      const header = readHeader(writerPath);
      const store = new SessionStore(writerPath, { kind: "pending", header }, writer.key);
      if (existsSync(sessionStorageDir(writerPath))) await store.live();
      return store;
    } catch (error) {
      releaseWriter(writer.key);
      throw error;
    }
  }

  static async inspectExecution(path: string): Promise<{
    open: boolean;
    started: boolean;
    result?: { status: SessionRunStatus; endedAt: number };
  }> {
    return withSessionSnapshot(path, async (root, harness) => {
      if (!root || !harness) return { open: false, started: false };
      const live = await harness.snapshot(LiveDoc, root.id, context);
      const run = (await harness.snapshot(SessionDoc, root.id, context))?.run;
      const open = live?.run !== undefined;
      return {
        open,
        started: open || run !== undefined,
        result:
          run?.endedAt !== undefined && run.status !== undefined
            ? { status: run.status, endedAt: run.endedAt }
            : undefined,
      };
    });
  }

  static async inspect(path: string): Promise<SessionInspection> {
    const resolvedPath = canonicalSessionPath(path);
    const header = readHeader(resolvedPath);
    return withSessionSnapshot(resolvedPath, async (root, harness) => {
      if (!root || !harness) {
        return new CachedSessionInspection(header, [], undefined, { messages: [] });
      }
      const name = (await harness.snapshot(SessionDoc, root.id, context))?.name;
      return new CachedSessionInspection(
        header,
        await readEntries(root, header.id),
        name,
        await readContext(root),
      );
    });
  }

  static async create(path: string, options?: SessionCreateInfo): Promise<SessionStore> {
    const writer = acquireWriter(path);
    let leaseKey = writer.key;
    try {
      if (existsSync(writer.path)) throw new Error(`Session file already exists: ${writer.path}`);
      const header = buildHeader(options);
      writeHeader(writer.path, header);
      leaseKey = promotePendingWriter(leaseKey, writer.path);
      const store = new SessionStore(writer.path, { kind: "pending", header }, leaseKey);
      await store.live();
      return store;
    } catch (error) {
      releaseWriter(leaseKey);
      throw error;
    }
  }

  static readHeader(path: string): SessionHeader | null {
    try {
      return readHeader(path);
    } catch {
      return null;
    }
  }

  static writeHeaderFile(path: string, options?: SessionCreateInfo): void {
    writeHeader(path, buildHeader(options));
  }

  static inMemory(): SessionStore {
    return new SessionStore(null, { kind: "pending", header: buildHeader() }, null);
  }

  getHeader(): SessionHeader {
    this.assertOpen();
    return structuredClone(this.state.header);
  }

  getSessionId(): string {
    this.assertOpen();
    return this.state.header.id;
  }

  async getEntries(): Promise<SessionEntry[]> {
    this.assertOpen();
    if (this.state.kind === "pending") return [];
    return readEntries(this.state.root, this.state.header.id);
  }

  async getContextEntries(): Promise<SessionEntry[]> {
    this.assertOpen();
    if (this.state.kind === "pending") return [];
    const view = await this.state.root.context(context);
    return toSessionEntries(view.entries, this.state.header.id);
  }

  async getContextTokens(): Promise<number | undefined> {
    this.assertOpen();
    if (this.state.kind === "pending") return undefined;
    const view = await this.state.root.context(context);
    const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
    for (const record of view.entries.toReversed()) {
      const message = record.model?.[0];
      if (record.id <= after || !AssistantEntry.is(record) || message?.role !== "assistant")
        continue;
      if (message.stopReason === "aborted" || message.stopReason === "error") continue;
      return calculateContextTokens(message.usage);
    }
    return undefined;
  }

  async getSessionName(): Promise<string | undefined> {
    this.assertOpen();
    if (this.state.kind === "pending") return undefined;
    return (await this.state.harness.snapshot(SessionDoc, this.state.root.id, context))?.name;
  }

  async buildSessionContext(): Promise<SessionContext> {
    this.assertOpen();
    if (this.state.kind === "pending") return { messages: [] };
    return readContext(this.state.root);
  }

  async connectMcp(servers: Record<string, McpServerConfig>, signal?: AbortSignal) {
    return this.mutate(async () => {
      if (this.mcp) throw new Error("SessionStore already has MCP connections");
      this.mcp = await loadMcpTools(servers, signal);
      for (const error of this.mcp.errors) {
        log.logWarning(`MCP server unavailable: ${error.server}`, error.error);
      }
      signal?.throwIfAborted();
      return this.mcp.tools;
    });
  }

  withMcpInstructions(prompt: string): string {
    const instructions = formatMcpServerInstructions(this.mcp?.instructions ?? []);
    return instructions ? `${prompt}\n\n${instructions}` : prompt;
  }

  async bindHarness(binding: SessionHarnessBinding): Promise<AttachedSessionHarness> {
    return this.mutate(async () => {
      if (this.binding) throw new Error("SessionStore already has an attached harness");
      this.binding = binding;
      const live = await this.live();
      return { harness: live.harness, root: live.root, registry: this.registry };
    });
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    return this.mutate(async () => {
      const { root } = await this.live();
      const model = [durableMessage(message)];
      const entry = await root.commit((tx): Promise<EntryRecord> => {
        switch (message.role) {
          case "user":
            return tx.appendEntry(UserEntry, root.id, { model });
          case "assistant":
            return tx.appendEntry(AssistantEntry, root.id, { model });
          case "toolResult":
            return tx.appendEntry(ToolResultEntry, root.id, { model, data: { diagnostics: [] } });
          default:
            throw new Error("Only user, assistant, and tool result messages enter a session");
        }
      }, context);
      return `${this.state.header.id}:${entry.id}`;
    });
  }

  async appendCustomEntry(
    customType: string,
    data?: unknown,
    timestamp = Date.now(),
  ): Promise<string> {
    return this.mutate(async () => {
      const { root } = await this.live();
      const entry = await root.commit(
        (tx) =>
          tx.appendEntry(CustomSessionEntry, root.id, {
            data: { customType, data: toJson(data), timestamp },
          }),
        context,
      );
      return `${this.state.header.id}:${entry.id}`;
    });
  }

  async appendCompactionSummary(summary: string, timestamp: number): Promise<string> {
    const text = wrapCompactionSummary(summary);
    return this.mutate(async () => {
      const { root } = await this.live();
      const entry = await root.commit(
        (tx) =>
          tx.appendEntry(CompactionEntry, root.id, {
            model: [{ role: "user", content: [{ type: "text", text }], timestamp }],
            data: { reason: "manual" },
            head: "self",
          }),
        context,
      );
      return `${this.state.header.id}:${entry.id}`;
    });
  }

  async setSessionName(name: string): Promise<void> {
    await this.updateSessionDoc((doc) => {
      doc.name = name.trim() || undefined;
    });
  }

  async recordRun(run: SessionRunRecord): Promise<void> {
    await this.updateSessionDoc((doc) => {
      doc.run = { ...run };
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.mutationTail
      .then(async () => {
        try {
          await this.mcp?.dispose();
        } finally {
          if (this.state.kind === "live") await this.state.harness.close(context);
        }
      })
      .finally(() => {
        if (this.writerKey !== null) releaseWriter(this.writerKey);
      });
    return this.closePromise;
  }

  private async updateSessionDoc(change: (doc: SessionDocState) => void): Promise<void> {
    await this.mutate(async () => {
      const { root } = await this.live();
      await root.commit(async (tx) => {
        change(await tx.doc(SessionDoc, root.id));
      }, context);
    });
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
    const { header } = this.state;
    let storage: Storage;
    if (this.sessionFile === null) {
      storage = new MemoryStorage();
    } else {
      if (!existsSync(this.sessionFile)) writeHeader(this.sessionFile, header);
      if (this.writerKey === null) throw new Error("Persisted session must have a writer lease");
      this.writerKey = promotePendingWriter(this.writerKey, this.sessionFile);
      storage = await openPrivateJsonlStorage(sessionStorageDir(this.sessionFile));
    }
    const harness = await Harness.open(
      storage,
      lateBoundOptions(this.registry, () => this.binding),
      context,
    );
    try {
      const live: LiveState = { kind: "live", header, harness, root: await harness.root(context) };
      this.state = live;
      return live;
    } catch (error) {
      await harness.close(context);
      throw error;
    }
  }
}
