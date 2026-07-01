import { uuidv7, type AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "@earendil-works/pi-agent-core";
import * as log from "../log.js";
import type { SessionContext, SessionEntry, SessionHeader } from "./types.js";

export type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
} from "./types.js";

const CURRENT_SESSION_VERSION = 3;

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

/** Validates a parsed first line is a real session header, not arbitrary JSON. */
function isValidHeader(value: unknown): value is SessionHeader {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "session" &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.timestamp === "string" &&
    record.timestamp.length > 0 &&
    typeof record.cwd === "string" &&
    record.cwd.length > 0
  );
}

function parseEntries(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  let header: unknown;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    header = undefined;
  }
  if (!isValidHeader(header) || header.version !== CURRENT_SESSION_VERSION) {
    log.logWarning(
      `Session file has an invalid or unsupported header, starting a fresh session`,
      filePath,
    );
    return [];
  }

  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as SessionEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SessionEntry => entry !== null);
}

/** Walks the parentId chain from the leaf back to (but excluding) the session header. */
function walkPath(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  index: Map<string, SessionEntry>,
): SessionEntry[] {
  if (leafId === null) return [];

  let leaf = leafId ? index.get(leafId) : undefined;
  leaf ??= entries.toReversed().find((entry) => entry.type !== "session");
  if (!leaf || leaf.type === "session") return [];

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    const parentId: string | null = "parentId" in current ? current.parentId : null;
    current = parentId ? index.get(parentId) : undefined;
  }
  path.reverse();
  return path;
}

function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionContext {
  const index = byId ?? new Map(entries.filter(hasEntryId).map((entry) => [entry.id, entry]));
  const path = walkPath(entries, leafId, index);
  if (path.length === 0) return { messages: [], thinkingLevel: "off", model: null };

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

  /** Entries on the path from the session root to the current leaf, excluding the header. */
  getBranch(): SessionEntry[] {
    return walkPath(this.entries, this.leafId, this.byId);
  }

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
      details,
      fromHook,
    });
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
