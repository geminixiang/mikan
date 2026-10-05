import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  UserEntry,
  createRegistry,
  defineDoc,
  defineEntry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type HarnessOptions,
  type HarnessSettings,
  type Registry,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Office } from "../office/types.js";
import type {
  AttachedSessionHarness,
  ChatHistoryMessageIdentity,
  ImportedSession,
  ImportedSessionEntry,
  SessionHarnessBinding,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionInspection,
  SessionListing,
  SessionRunRecord,
  SessionRunStatus,
} from "./types.js";
import { RUN_CAUSE_CUSTOM_TYPE } from "./types.js";
import { loadMcpTools } from "../harness/mcp.js";
import type { McpServerConfig, McpServerSummary, McpToolsResult } from "../harness/types.js";
import * as log from "../log.js";
import { compactionSummaryOf, wrapCompactionSummary } from "./compaction-summary.js";
import { isThreadSessionKey } from "./session-key.js";
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

type SessionIndexRecord = Required<{
  conversationId: number;
  id: string;
  createdAt: number;
}>;

type SessionIndexState = Required<{ sessions: Record<string, SessionIndexRecord> }>;

const SessionIndexDoc = defineDoc<SessionIndexState>({
  kind: "mikan.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
});

const ChatHistoryEntry = defineEntry<Readonly<ChatHistoryMessageIdentity>>("mikan.chat_history");

const CustomSessionEntry = defineEntry<{
  customType: string;
  data: JsonValue;
  timestamp: number;
}>("mikan.custom");

interface BoundSessionHarness {
  binding: SessionHarnessBinding;
  providerSessionId: string;
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
  if (
    UserEntry.is(record) ||
    ChatHistoryEntry.is(record) ||
    AssistantEntry.is(record) ||
    ToolResultEntry.is(record)
  ) {
    if (!message) return undefined;
    return {
      type: "message",
      id,
      timestamp: messageTimestamp(message),
      message,
      history: ChatHistoryEntry.is(record) ? record.data : undefined,
    };
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

async function readRecords(conversation: Conversation): Promise<EntryRecord[]> {
  const records: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await conversation.entries({}, ENTRY_PAGE_SIZE, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return records.toReversed();
}

async function readContext(conversation: Conversation): Promise<SessionContext> {
  const view = await conversation.context(context);
  const messages: AgentMessage[] = view.messages
    .filter((message) => message.role !== "system")
    .map(durableMessage);
  return { messages };
}

function bindModels(models: Models, property: PropertyKey): unknown {
  const value = Reflect.get(models, property, models) as unknown;
  return typeof value === "function" ? value.bind(models) : value;
}

function requestSessionId(options: unknown): string | undefined {
  return isRecord(options) && typeof options.sessionId === "string" ? options.sessionId : undefined;
}

function protectStorageFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

const REQUEST_METHODS = new Set<PropertyKey>(["streamSimple", "completeSimple"]);

class OfficeStorage {
  private static readonly pool = new Map<string, Promise<OfficeStorage>>();
  readonly registry: Registry = createRegistry();
  private opened: Harness | undefined;
  private refs = 0;
  private readonly bindings = new Map<ConversationId, BoundSessionHarness>();
  private readonly writers = new Set<ConversationId>();

  private constructor(private readonly path: string | null) {}

  get harness(): Harness {
    if (!this.opened) throw new Error("Office session storage is not open");
    return this.opened;
  }

  static async acquire(path: string): Promise<OfficeStorage> {
    let pending = OfficeStorage.pool.get(path);
    if (!pending) {
      pending = OfficeStorage.openShared(path);
      OfficeStorage.pool.set(path, pending);
      pending.catch(() => OfficeStorage.pool.delete(path));
    }
    const storage = await pending;
    storage.refs += 1;
    return storage;
  }

  static async inMemory(): Promise<OfficeStorage> {
    const storage = await OfficeStorage.open(null, new MemoryStorage());
    storage.refs = 1;
    return storage;
  }

  private static async openShared(path: string): Promise<OfficeStorage> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const storage = await OfficeStorage.open(path, await openNodeSqliteStorage(path));
    protectStorageFiles(path);
    await storage.abortUnfinishedWork();
    return storage;
  }

  private static async open(path: string | null, backend: Storage): Promise<OfficeStorage> {
    const storage = new OfficeStorage(path);
    storage.opened = await Harness.open(backend, storage.harnessOptions(), context);
    return storage;
  }

  private harnessOptions(): HarnessOptions {
    const latest = (): SessionHarnessBinding | undefined =>
      [...this.bindings.values()].at(-1)?.binding;
    const fallback = (): Models => {
      const models = latest()?.models;
      if (!models) throw new Error("Session has no model binding; start a run to use the model");
      return models;
    };
    const models = new Proxy({} as Models, {
      get: (_target, property) => {
        if (!REQUEST_METHODS.has(property)) return bindModels(fallback(), property);
        return (...args: unknown[]) => {
          const sessionId = requestSessionId(args[2]);
          const binding = [...this.bindings.values()].find(
            (bound) => bound.providerSessionId === sessionId,
          )?.binding;
          if (!binding) throw new Error("Provider request has no active session binding");
          const target = binding.requestModels ?? binding.models;
          const method = Reflect.get(target, property, target) as (...input: unknown[]) => unknown;
          return method.apply(target, args);
        };
      },
    });
    const settings = (): HarnessSettings | undefined => latest()?.settings;
    return {
      models,
      registry: this.registry,
      settings: {
        extensions: [],
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
      env: (target, envContext) =>
        this.bindings.get(target.conversationId)?.binding.env?.(target, envContext),
      onReport: (error) => {
        const report = latest()?.onReport;
        if (report) report(error);
        else log.logWarning("Durable harness report", errorMessage(error));
      },
    };
  }

  private async abortUnfinishedWork(): Promise<void> {
    const { tasks } = await this.harness.inspect(context);
    const unowned = tasks.filter((task) => !task.record.owner);
    if (unowned.length === 0) return;
    log.logWarning(
      `Aborting ${unowned.length} durable tasks left unfinished by a previous process`,
    );
    for (const task of unowned) await this.harness.abortTask(task.record.id, context);
  }

  async index(): Promise<Readonly<Record<string, SessionIndexRecord>>> {
    return (await this.harness.snapshot(SessionIndexDoc, context))?.sessions ?? {};
  }

  claimWriter(conversationId: ConversationId, key: string): void {
    if (this.writers.has(conversationId)) {
      throw new Error(`Session already has an active writer: ${key}`);
    }
    this.writers.add(conversationId);
  }

  releaseWriter(conversationId: ConversationId): void {
    this.writers.delete(conversationId);
  }

  async bind(conversationId: ConversationId, binding: SessionHarnessBinding): Promise<void> {
    if (this.bindings.has(conversationId)) {
      throw new Error("Session already has an attached harness");
    }
    const providerSessionId =
      (await this.harness.snapshot(ProviderDoc, conversationId, context))?.sessionId ??
      (await this.harness.commit(
        async (tx) => (await tx.doc(ProviderDoc, conversationId)).sessionId,
        context,
      ));
    this.bindings.set(conversationId, { binding, providerSessionId });
  }

  unbind(conversationId: ConversationId): void {
    this.bindings.delete(conversationId);
  }

  async release(): Promise<void> {
    this.refs -= 1;
    if (this.refs > 0) return;
    if (this.path !== null) OfficeStorage.pool.delete(this.path);
    await this.harness.close(context);
  }
}

function writeSessionIndex(tx: Tx, key: string, record: SessionIndexRecord): Promise<void> {
  return tx.doc(SessionIndexDoc).then((doc) => {
    doc.sessions[key] = record;
  });
}

async function lookupSession(
  storage: OfficeStorage,
  key: string,
): Promise<{ conversation: Conversation; record: SessionIndexRecord } | undefined> {
  const record = (await storage.index())[key];
  if (!record) return undefined;
  const conversation = await storage.harness.conversation(
    record.conversationId as ConversationId,
    context,
  );
  return conversation ? { conversation, record } : undefined;
}

async function createSession(
  storage: OfficeStorage,
  key: string,
): Promise<{ conversation: Conversation; record: SessionIndexRecord }> {
  let record: SessionIndexRecord | undefined;
  const init = async (tx: Tx, conversationId: ConversationId) => {
    record = { conversationId, id: randomUUID(), createdAt: Date.now() };
    await writeSessionIndex(tx, key, record);
  };
  const conversation = isThreadSessionKey(key)
    ? await storage.harness.createConversation({ ownership: { kind: "ownerless" }, init }, context)
    : await storage.harness.root(context, { init });
  if (!record) {
    record = { conversationId: conversation.id, id: randomUUID(), createdAt: Date.now() };
    const created = record;
    await conversation.commit((tx) => writeSessionIndex(tx, key, created), context);
  }
  return { conversation, record };
}

async function parentSessionId(
  storage: OfficeStorage,
  conversationId: ConversationId,
): Promise<string | undefined> {
  const parent = await storage.harness.commit(
    async (tx) => (await tx.conversation(conversationId))?.parent,
    context,
  );
  if (!parent) return undefined;
  const records = Object.values(await storage.index());
  return records.find((record) => record.conversationId === parent.conversationId)?.id;
}

function isRunCause(record: EntryRecord, messageId?: string): boolean {
  if (!CustomSessionEntry.is(record) || record.data.customType !== RUN_CAUSE_CUSTOM_TYPE) {
    return false;
  }
  const { data } = record.data;
  return messageId === undefined || (isRecord(data) && data.messageId === messageId);
}

function runEnd(records: readonly EntryRecord[], messageId: string): EntryId | undefined {
  const start = records.findLastIndex((record) => isRunCause(record, messageId));
  if (start < 0) return undefined;
  const next = records.findIndex((record, index) => index > start && isRunCause(record));
  const run = records.slice(start, next < 0 ? undefined : next);
  return (run.findLast((record) => AssistantEntry.is(record)) ?? run.at(-1))?.id;
}

const EARLIER_SESSION_PREFIX = "earlier:";

export function earlierSessionKey(sessionId: string): string {
  return `${EARLIER_SESSION_PREFIX}${sessionId}`;
}

export function isEarlierSessionKey(key: string): boolean {
  return key.startsWith(EARLIER_SESSION_PREFIX);
}

async function appendSessionEntry(
  tx: Tx,
  conversationId: ConversationId,
  entry: ImportedSessionEntry,
): Promise<void> {
  switch (entry.type) {
    case "message": {
      if (entry.history !== undefined && entry.message.role !== "user") {
        throw new Error("Chat history must enter as an attributed user message");
      }
      const model = [durableMessage(entry.message)];
      if (entry.history !== undefined) {
        await tx.appendEntry(ChatHistoryEntry, conversationId, { model, data: entry.history });
      } else if (entry.message.role === "user") {
        await tx.appendEntry(UserEntry, conversationId, { model });
      } else if (entry.message.role === "assistant") {
        await tx.appendEntry(AssistantEntry, conversationId, { model });
      } else {
        await tx.appendEntry(ToolResultEntry, conversationId, {
          model,
          data: { diagnostics: [] },
        });
      }
      return;
    }
    case "compaction":
      await tx.appendEntry(CompactionEntry, conversationId, {
        model: [
          {
            role: "user",
            content: [{ type: "text", text: wrapCompactionSummary(entry.summary) }],
            timestamp: entry.timestamp,
          },
        ],
        data: { reason: "manual" },
        head: "self",
      });
      return;
    case "custom":
      await tx.appendEntry(CustomSessionEntry, conversationId, {
        data: {
          customType: entry.customType,
          data: toJson(entry.data),
          timestamp: entry.timestamp,
        },
      });
      return;
    default:
      entry satisfies never;
  }
}

export async function importOfficeSessions(
  path: string,
  sessions: readonly ImportedSession[],
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models: {} as Models, registry: createRegistry(), settings: { extensions: [] } },
    context,
  );
  try {
    for (const session of sessions) {
      const init = async (tx: Tx, conversationId: ConversationId) => {
        for (const entry of session.entries) await appendSessionEntry(tx, conversationId, entry);
        if (session.name) (await tx.doc(SessionDoc, conversationId)).name = session.name;
        await writeSessionIndex(tx, session.key, {
          conversationId,
          id: session.id,
          createdAt: session.createdAt,
        });
      };
      if (session.root) await harness.root(context, { init });
      else await harness.createConversation({ ownership: { kind: "ownerless" }, init }, context);
    }
  } finally {
    await harness.close(context);
  }
  protectStorageFiles(path);
}

export async function readImportedContexts(path: string): Promise<Map<string, AgentMessage[]>> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models: {} as Models, registry: createRegistry(), settings: { extensions: [] } },
    context,
  );
  try {
    const index = (await harness.snapshot(SessionIndexDoc, context))?.sessions ?? {};
    const contexts = new Map<string, AgentMessage[]>();
    for (const [key, record] of Object.entries(index)) {
      const conversation = await harness.conversation(
        record.conversationId as ConversationId,
        context,
      );
      if (conversation) contexts.set(key, (await readContext(conversation)).messages);
    }
    return contexts;
  } finally {
    await harness.close(context);
  }
}

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

async function withOfficeStorage<T>(
  office: Office,
  read: (storage: OfficeStorage) => Promise<T>,
): Promise<T> {
  const storage = await OfficeStorage.acquire(office.sessionsPath);
  try {
    return await read(storage);
  } finally {
    await storage.release();
  }
}

export class SessionStore implements SessionInspection {
  private mcp: McpToolsResult | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private bound = false;

  private constructor(
    private readonly storage: OfficeStorage,
    private readonly conversation: Conversation,
    private readonly header: SessionHeader,
  ) {}

  static async open(office: Office, key: string): Promise<SessionStore> {
    const storage = await OfficeStorage.acquire(office.sessionsPath);
    try {
      const session = (await lookupSession(storage, key)) ?? (await createSession(storage, key));
      storage.claimWriter(session.conversation.id, key);
      return new SessionStore(storage, session.conversation, {
        id: session.record.id,
        createdAt: session.record.createdAt,
        parentSessionId: await parentSessionId(storage, session.conversation.id),
      });
    } catch (error) {
      await storage.release();
      throw error;
    }
  }

  static async forkRun(
    office: Office,
    key: string,
    cause: { sessionKey: string; messageId: string },
    entries: readonly ImportedSessionEntry[],
  ): Promise<boolean> {
    return withOfficeStorage(office, async (storage) => {
      if ((await storage.index())[key]) return false;
      const parent = await lookupSession(storage, cause.sessionKey);
      if (!parent) return false;
      const at = runEnd(await readRecords(parent.conversation), cause.messageId);
      if (at === undefined) return false;
      await parent.conversation.fork(
        at,
        {
          ownership: { kind: "ownerless" },
          init: async (tx, conversationId) => {
            for (const entry of entries) await appendSessionEntry(tx, conversationId, entry);
            await writeSessionIndex(tx, key, {
              conversationId,
              id: randomUUID(),
              createdAt: Date.now(),
            });
          },
        },
        context,
      );
      return true;
    });
  }

  static async inMemory(): Promise<SessionStore> {
    const storage = await OfficeStorage.inMemory();
    const conversation = await storage.harness.root(context);
    return new SessionStore(storage, conversation, { id: randomUUID(), createdAt: Date.now() });
  }

  static async exists(office: Office, key: string): Promise<boolean> {
    if (!existsSync(office.sessionsPath)) return false;
    return withOfficeStorage(office, async (storage) => (await storage.index())[key] !== undefined);
  }

  static async list(office: Office): Promise<SessionListing[]> {
    if (!existsSync(office.sessionsPath)) return [];
    return withOfficeStorage(office, async (storage) => {
      const index = await storage.index();
      const byConversation = new Map(
        Object.values(index).map((record) => [record.conversationId, record.id]),
      );
      return Promise.all(
        Object.entries(index).map(async ([key, record]) => {
          const parent = await storage.harness.commit(
            async (tx) => (await tx.conversation(record.conversationId as ConversationId))?.parent,
            context,
          );
          const parentId = parent ? byConversation.get(parent.conversationId) : undefined;
          return {
            key,
            id: record.id,
            createdAt: record.createdAt,
            root: record.conversationId === ROOT_CONVERSATION_ID,
            parentSessionId: parentId,
            forkEntryId: parent && parentId ? `${parentId}:${parent.at}` : undefined,
          };
        }),
      );
    });
  }

  static async inspect(office: Office, key: string): Promise<SessionInspection | undefined> {
    if (!existsSync(office.sessionsPath)) return undefined;
    return withOfficeStorage(office, async (storage) => {
      const session = await lookupSession(storage, key);
      if (!session) return undefined;
      const { conversation, record } = session;
      const name = (await storage.harness.snapshot(SessionDoc, conversation.id, context))?.name;
      return new CachedSessionInspection(
        {
          id: record.id,
          createdAt: record.createdAt,
          parentSessionId: await parentSessionId(storage, conversation.id),
        },
        toSessionEntries(await readRecords(conversation), record.id),
        name,
        await readContext(conversation),
      );
    });
  }

  static async inspectExecution(
    office: Office,
    key: string,
  ): Promise<{
    open: boolean;
    started: boolean;
    result?: { status: SessionRunStatus; endedAt: number };
  }> {
    if (!existsSync(office.sessionsPath)) return { open: false, started: false };
    return withOfficeStorage(office, async (storage) => {
      const session = await lookupSession(storage, key);
      if (!session) return { open: false, started: false };
      const id = session.conversation.id;
      const live = await storage.harness.snapshot(LiveDoc, id, context);
      const run = (await storage.harness.snapshot(SessionDoc, id, context))?.run;
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

  getHeader(): SessionHeader {
    this.assertOpen();
    return structuredClone(this.header);
  }

  getSessionId(): string {
    this.assertOpen();
    return this.header.id;
  }

  async getEntries(): Promise<SessionEntry[]> {
    this.assertOpen();
    return toSessionEntries(await readRecords(this.conversation), this.header.id);
  }

  async getContextEntries(): Promise<SessionEntry[]> {
    this.assertOpen();
    const view = await this.conversation.context(context);
    return toSessionEntries(view.entries, this.header.id);
  }

  async getContextTokens(): Promise<number | undefined> {
    this.assertOpen();
    const view = await this.conversation.context(context);
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
    return (await this.storage.harness.snapshot(SessionDoc, this.conversation.id, context))?.name;
  }

  async buildSessionContext(): Promise<SessionContext> {
    this.assertOpen();
    return readContext(this.conversation);
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

  mcpServers(): readonly McpServerSummary[] {
    return this.mcp?.servers ?? [];
  }

  async bindHarness(binding: SessionHarnessBinding): Promise<AttachedSessionHarness> {
    return this.mutate(async () => {
      await this.storage.bind(this.conversation.id, binding);
      this.bound = true;
      const conversationId = this.conversation.id;
      return {
        harness: this.storage.harness,
        conversation: this.conversation,
        registry: this.storage.registry,
        extensionName: `mikan.${conversationId}`,
      };
    });
  }

  async appendEntries(entries: readonly ImportedSessionEntry[]): Promise<void> {
    await this.mutate(() =>
      this.conversation.commit(async (tx) => {
        for (const entry of entries) await appendSessionEntry(tx, this.conversation.id, entry);
      }, context),
    );
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    return this.mutate(async () => {
      const conversation = this.conversation;
      const model = [durableMessage(message)];
      const entry = await conversation.commit((tx): Promise<EntryRecord> => {
        switch (message.role) {
          case "user":
            return tx.appendEntry(UserEntry, conversation.id, { model });
          case "assistant":
            return tx.appendEntry(AssistantEntry, conversation.id, { model });
          case "toolResult":
            return tx.appendEntry(ToolResultEntry, conversation.id, {
              model,
              data: { diagnostics: [] },
            });
          default:
            throw new Error("Only user, assistant, and tool result messages enter a session");
        }
      }, context);
      return `${this.header.id}:${entry.id}`;
    });
  }

  async appendCustomEntry(
    customType: string,
    data?: unknown,
    timestamp = Date.now(),
  ): Promise<string> {
    return this.mutate(async () => {
      const conversation = this.conversation;
      const entry = await conversation.commit(
        (tx) =>
          tx.appendEntry(CustomSessionEntry, conversation.id, {
            data: { customType, data: toJson(data), timestamp },
          }),
        context,
      );
      return `${this.header.id}:${entry.id}`;
    });
  }

  async appendCompactionSummary(summary: string, timestamp: number): Promise<string> {
    const text = wrapCompactionSummary(summary);
    return this.mutate(async () => {
      const conversation = this.conversation;
      const entry = await conversation.commit(
        (tx) =>
          tx.appendEntry(CompactionEntry, conversation.id, {
            model: [{ role: "user", content: [{ type: "text", text }], timestamp }],
            data: { reason: "manual" },
            head: "self",
          }),
        context,
      );
      return `${this.header.id}:${entry.id}`;
    });
  }

  async reset(): Promise<void> {
    await this.mutate(() => this.conversation.reset(undefined, context));
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
    const conversationId = this.conversation.id;
    this.closePromise = this.mutationTail.then(async () => {
      try {
        await this.mcp?.dispose();
      } finally {
        if (this.bound) {
          this.storage.registry.uninstall({ name: `mikan.${conversationId}` });
          this.storage.unbind(conversationId);
        }
        this.storage.releaseWriter(conversationId);
        await this.storage.release();
      }
    });
    return this.closePromise;
  }

  private async updateSessionDoc(change: (doc: SessionDocState) => void): Promise<void> {
    await this.mutate(async () => {
      const conversation = this.conversation;
      await conversation.commit(async (tx) => {
        change(await tx.doc(SessionDoc, conversation.id));
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
}
