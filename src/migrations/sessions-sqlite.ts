import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { OfficeRegistry, officeStateDir } from "../office/index.js";
import {
  earlierSessionKey,
  importOfficeSessions,
  readImportedContexts,
} from "../sessions/session-store.js";
import { makeThreadSessionKey } from "../sessions/session-key.js";
import type { ImportedSession, ImportedSessionEntry } from "../sessions/types.js";
import { readTextFileIfExists } from "../file-guards.js";
import {
  epochMillis,
  isV3SessionFile,
  pathTo,
  readV3Session,
  type V3Entry,
  type V3Session,
} from "./session-v3.js";
import type { Migration, MigrationContext } from "./types.js";

const SESSIONS_DIR = "sessions";
const ARCHIVE_DIR = "sessions-v3";
const STORAGE_FILENAME = "sessions.db";
const TEMP_SUFFIX = ".importing";
const MAIN_SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f]{8}\.jsonl$/i;
const INTERRUPTED_RESULT =
  "This tool call was interrupted by the upgrade to Pi 1.0; its outcome is unknown.";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
const BRANCH_SUMMARY_SUFFIX = "</summary>";
const LEGACY_SETTING_TYPES: ReadonlySet<string> = new Set([
  "thinking_level_change",
  "model_change",
]);

function isModelMessage(value: { role: unknown }): value is Message {
  return value.role === "user" || value.role === "assistant" || value.role === "toolResult";
}

function isContextMessage(message: Message): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

function userMessage(content: Extract<Message, { role: "user" }>["content"], timestamp: number) {
  return {
    role: "user" as const,
    content: typeof content === "string" ? [{ type: "text" as const, text: content }] : content,
    timestamp,
  };
}

function messageOf(entry: V3Entry): Message | undefined {
  const timestamp = epochMillis(entry.timestamp);
  switch (entry.type) {
    case "message":
      return isModelMessage(entry.message) ? entry.message : undefined;
    case "custom_message":
      return userMessage(entry.content, timestamp);
    case "branch_summary":
      return entry.summary
        ? userMessage(BRANCH_SUMMARY_PREFIX + entry.summary + BRANCH_SUMMARY_SUFFIX, timestamp)
        : undefined;
    default:
      return undefined;
  }
}

class EntryCollector {
  readonly entries: ImportedSessionEntry[] = [];
  private readonly openCalls = new Map<string, { name: string; timestamp: number }>();

  get messageCount(): number {
    return this.entries.filter((entry) => entry.type !== "custom").length;
  }

  message(message: Message): void {
    if (!isContextMessage(message)) return;
    if (message.role === "toolResult") {
      if (!this.openCalls.delete(message.toolCallId)) return;
    } else {
      this.closeOpenCalls();
    }
    this.entries.push({ type: "message", message });
    if (message.role === "assistant") this.trackCalls(message);
  }

  compaction(summary: string, timestamp: number): void {
    this.closeOpenCalls();
    this.entries.push({ type: "compaction", summary, timestamp });
  }

  custom(customType: string, data: unknown, timestamp: number): void {
    this.entries.push({ type: "custom", customType, data, timestamp });
  }

  closeOpenCalls(): void {
    for (const [toolCallId, call] of this.openCalls) {
      this.entries.push({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId,
          toolName: call.name,
          content: [{ type: "text", text: INTERRUPTED_RESULT }],
          isError: true,
          timestamp: call.timestamp,
        },
      });
    }
    this.openCalls.clear();
  }

  private trackCalls(message: AssistantMessage): void {
    for (const part of message.content) {
      if (part.type === "toolCall") {
        this.openCalls.set(part.id, { name: part.name, timestamp: message.timestamp });
      }
    }
  }
}

function keptMessages(session: V3Session, entry: Extract<V3Entry, { type: "compaction" }>) {
  const ancestors = pathTo(session.entriesById, entry.parentId);
  const kept = ancestors.findIndex((ancestor) => ancestor.id === entry.firstKeptEntryId);
  if (kept === -1) return [];
  return ancestors
    .slice(kept)
    .filter((ancestor) => ancestor.type === "message" || ancestor.type === "custom_message");
}

function collectEntries(session: V3Session): EntryCollector {
  const collector = new EntryCollector();
  const visibleStart = session.branch.findLastIndex((entry) => entry.type === "compaction");
  for (const [index, entry] of session.branch.entries()) {
    const timestamp = epochMillis(entry.timestamp);
    if (entry.type === "custom") {
      collector.custom(entry.customType, entry.data, timestamp);
      continue;
    }
    if (LEGACY_SETTING_TYPES.has(entry.type)) {
      const { id: _id, parentId: _parentId, timestamp: _timestamp, type, ...data } = entry;
      collector.custom(`mikan.legacy.${type}`, data, timestamp);
      continue;
    }
    if (index < visibleStart) continue;
    if (entry.type === "compaction") {
      collector.compaction(entry.summary, timestamp);
      for (const kept of keptMessages(session, entry)) {
        const message = messageOf(kept);
        if (message) collector.message(message);
      }
      continue;
    }
    const message = messageOf(entry);
    if (message) collector.message(message);
  }
  collector.closeOpenCalls();
  return collector;
}

interface PlannedSession {
  file: string;
  session: ImportedSession;
  expectedMessages: number;
}

function sessionKeyFor(conversationId: string, fileName: string, current: string | undefined) {
  if (fileName === current) return { key: conversationId, root: true };
  if (MAIN_SESSION_FILENAME.test(fileName)) return { key: undefined, root: false };
  return {
    key: makeThreadSessionKey(conversationId, fileName.slice(0, -".jsonl".length)),
    root: false,
  };
}

function planOfficeImport(conversationId: string, sessionsDir: string): PlannedSession[] {
  const current = readTextFileIfExists(join(sessionsDir, "current"))?.trim() || undefined;
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .filter((entry) => isV3SessionFile(join(sessionsDir, entry.name)))
    .map((entry) => {
      const file = join(sessionsDir, entry.name);
      const v3 = readV3Session(file);
      const collected = collectEntries(v3);
      const { key, root } = sessionKeyFor(conversationId, entry.name, current);
      return {
        file,
        expectedMessages: collected.messageCount,
        session: {
          key: key ?? earlierSessionKey(v3.id),
          id: v3.id,
          createdAt: v3.createdAt,
          root,
          name: v3.name,
          entries: collected.entries,
        },
      };
    });
}

async function verifyImport(temp: string, planned: readonly PlannedSession[]): Promise<void> {
  const contexts = await readImportedContexts(temp);
  for (const { file, session, expectedMessages } of planned) {
    const imported = contexts.get(session.key)?.length ?? 0;
    if (imported < expectedMessages) {
      throw new Error(
        `Imported context of ${file} has ${imported} messages; expected at least ${expectedMessages}`,
      );
    }
  }
}

function hasV3Sessions(sessionsDir: string): boolean {
  if (!existsSync(sessionsDir)) return false;
  return readdirSync(sessionsDir, { withFileTypes: true }).some(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      isV3SessionFile(join(sessionsDir, entry.name)),
  );
}

async function migrateOffice(
  conversationId: string,
  officeDir: string,
  context: MigrationContext,
): Promise<void> {
  const sessionsDir = join(officeDir, SESSIONS_DIR);
  const archive = join(officeDir, ARCHIVE_DIR);
  const storage = join(officeDir, STORAGE_FILENAME);
  const temp = `${storage}${TEMP_SUFFIX}`;
  if (!existsSync(sessionsDir) && existsSync(temp) && existsSync(archive)) {
    context.report(`  finish ${storage}`);
    if (!context.dryRun) renameSync(temp, storage);
    return;
  }
  if (!hasV3Sessions(sessionsDir)) return;
  if (existsSync(storage)) throw new Error(`Session storage already exists: ${storage}`);
  if (existsSync(archive)) throw new Error(`Archived session files already exist: ${archive}`);
  const planned = planOfficeImport(conversationId, sessionsDir);
  context.report(`  ${planned.length} sessions -> ${storage}`);
  if (context.dryRun) return;
  rmSync(temp, { force: true });
  try {
    await importOfficeSessions(
      temp,
      planned.map((plan) => plan.session),
    );
    await verifyImport(temp, planned);
  } catch (error) {
    for (const file of [temp, `${temp}-wal`, `${temp}-shm`]) rmSync(file, { force: true });
    throw new Error(`Session migration failed for ${sessionsDir}`, { cause: error });
  }
  renameSync(sessionsDir, archive);
  renameSync(temp, storage);
}

function registeredOffices(stateDir: string): Array<{ conversationId: string; dir: string }> {
  return new OfficeRegistry(stateDir).getOffices().map((record) => ({
    conversationId: record.conversationId,
    dir: officeStateDir(stateDir, record),
  }));
}

function assertEveryOfficeRegistered(stateDir: string, registered: ReadonlySet<string>): void {
  const root = join(stateDir, "conversations");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (!registered.has(dir) && hasV3Sessions(join(dir, SESSIONS_DIR))) {
      throw new Error(
        `Sessions in ${dir} belong to no office in office-registry.json; record the office before migrating`,
      );
    }
  }
}

export const sessionsSqliteMigration: Migration = Object.freeze({
  id: "0009-sessions-sqlite",
  summary:
    "import 0.5.3 session files into one pi-durable SQLite storage per office, keeping originals under sessions-v3/",
  async run(context: MigrationContext): Promise<void> {
    const offices = registeredOffices(context.stateDir);
    assertEveryOfficeRegistered(context.stateDir, new Set(offices.map((office) => office.dir)));
    for (const office of offices) {
      await migrateOffice(office.conversationId, office.dir, context);
    }
  },
});
