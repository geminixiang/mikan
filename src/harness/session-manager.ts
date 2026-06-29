import { uuidv7, type AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "@earendil-works/pi-agent-core";

const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

type ThinkingLevelChangeEntry = SessionEntryBase & {
  type: "thinking_level_change";
  thinkingLevel: string;
};
type ModelChangeEntry = SessionEntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};
type CustomMessageEntry = SessionEntryBase & {
  type: "custom_message";
  customType: string;
  content: unknown;
  display: boolean;
  details?: unknown;
};
export type BranchSummaryEntry = SessionEntryBase & {
  type: "branch_summary";
  summary: string;
  fromId: string;
};
export type CompactionEntry = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
};
type LabelEntry = SessionEntryBase & { type: "label"; targetId: string; label?: string };
type CustomEntry = SessionEntryBase & { type: "custom"; customType: string; data?: unknown };
type SessionNameEntry = SessionEntryBase & { type: "session_name"; name: string };
type SessionInfoEntry = SessionEntryBase & { type: "session_info"; name?: string };

export type SessionEntry =
  | SessionHeader
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CustomMessageEntry
  | BranchSummaryEntry
  | CompactionEntry
  | LabelEntry
  | CustomEntry
  | SessionNameEntry
  | SessionInfoEntry;

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

function createSessionId(): string {
  return uuidv7();
}

function generateId(entries: SessionEntry[]): string {
  const used = new Set(entries.filter(hasEntryId).map((entry) => entry.id));
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!used.has(id)) return id;
  }
  return randomUUID();
}

function hasEntryId(entry: SessionEntry): entry is SessionEntry & { id: string } {
  return typeof (entry as { id?: unknown }).id === "string";
}

function parseEntries(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SessionEntry => entry !== null);
}

function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionContext {
  const index = byId ?? new Map(entries.filter(hasEntryId).map((entry) => [entry.id, entry]));
  if (leafId === null) return { messages: [], thinkingLevel: "off", model: null };

  let leaf = leafId ? index.get(leafId) : undefined;
  leaf ??= entries.toReversed().find((entry) => entry.type !== "session");
  if (!leaf || leaf.type === "session") return { messages: [], thinkingLevel: "off", model: null };

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    const parentId: string | null = "parentId" in current ? current.parentId : null;
    current = parentId ? index.get(parentId) : undefined;
  }
  path.reverse();

  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  let compaction: Extract<SessionEntry, { type: "compaction" }> | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
    if (entry.type === "compaction") compaction = entry;
  }

  const messages: AgentMessage[] = [];
  const appendMessage = (entry: SessionEntry): void => {
    if (entry.type === "message") messages.push(entry.message);
    if (entry.type === "custom_message") {
      messages.push(
        createCustomMessage(
          entry.customType,
          entry.content as Parameters<typeof createCustomMessage>[1],
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      );
    }
    if (entry.type === "branch_summary") {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  };

  if (!compaction) {
    for (const entry of path) appendMessage(entry);
    return { messages, thinkingLevel, model };
  }

  messages.push(
    createCompactionSummaryMessage(
      compaction.summary,
      compaction.tokensBefore,
      compaction.timestamp,
    ),
  );
  const compactionIndex = path.findIndex(
    (entry) => entry.type === "compaction" && entry.id === compaction.id,
  );
  let foundFirstKept = false;
  for (let i = 0; i < compactionIndex; i++) {
    const entry = path[i]!;
    if (entry.type !== "session" && entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
    if (foundFirstKept) appendMessage(entry);
  }
  for (let i = compactionIndex + 1; i < path.length; i++) appendMessage(path[i]!);
  return { messages, thinkingLevel, model };
}

export class SessionManager {
  private entries: SessionEntry[];
  private byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;
  private constructor(
    private cwd: string,
    private sessionDir: string,
    private sessionFile: string | undefined,
    private persist: boolean,
  ) {
    this.entries = sessionFile ? parseEntries(sessionFile) : [];
    if (this.entries.length === 0) this.newSession();
    this.rebuildIndex();
  }

  static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
    const resolvedPath = resolve(path);
    const entries = parseEntries(resolvedPath);
    const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
    const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
    return new SessionManager(cwd, sessionDir ?? dirname(resolvedPath), resolvedPath, true);
  }

  static create(cwd: string, sessionDir?: string): SessionManager {
    return new SessionManager(cwd, sessionDir ?? join(process.cwd(), ".sessions"), undefined, true);
  }

  static inMemory(cwd = process.cwd()): SessionManager {
    return new SessionManager(cwd, "", undefined, false);
  }

  getHeader(): SessionHeader | null {
    return this.entries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  }

  getEntries(): SessionEntry[] {
    return this.entries.filter((entry) => entry.type !== "session");
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  getSessionId(): string {
    return this.getHeader()?.id ?? "";
  }

  getSessionName(): string | undefined {
    const nameEntry = this.entries.toReversed().find((entry) => entry.type === "session_info");
    return nameEntry?.type === "session_info" ? nameEntry.name?.trim() || undefined : undefined;
  }

  setSessionName(name: string): void {
    this.appendSessionInfo(name);
  }

  appendSessionInfo(name: string): void {
    this.appendEntry({ type: "session_info", name: name.replace(/[\r\n]+/g, " ").trim() });
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.appendEntry({ type: "custom", customType, data });
  }

  appendMessage(message: AgentMessage): string {
    return this.appendEntry({ type: "message", message });
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.entries, this.leafId, this.byId);
  }

  private newSession(): void {
    const id = createSessionId();
    const timestamp = new Date().toISOString();
    this.entries = [
      { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: this.cwd },
    ];
    if (this.persist && !this.sessionFile) {
      this.sessionFile = join(this.sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    }
    this.flush();
  }

  private appendEntry(data: Record<string, unknown>): string {
    const id = generateId(this.entries);
    const entry = {
      ...data,
      id,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    this.entries.push(entry);
    this.leafId = id;
    this.byId.set(id, entry);
    this.persistEntry(entry);
    return id;
  }

  private rebuildIndex(): void {
    this.byId.clear();
    this.leafId = null;
    for (const entry of this.entries) {
      if (entry.type === "session") continue;
      if (hasEntryId(entry)) {
        this.byId.set(entry.id, entry);
        this.leafId = entry.id;
      }
    }
  }

  private flush(): void {
    if (!this.persist || !this.sessionFile) return;
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    writeFileSync(
      this.sessionFile,
      `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
  }

  private persistEntry(entry: SessionEntry): void {
    if (!this.persist || !this.sessionFile) return;
    mkdirSync(dirname(this.sessionFile), { recursive: true });
    if (existsSync(this.sessionFile)) {
      appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
    } else {
      this.flush();
    }
  }
}
