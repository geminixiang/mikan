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
  branchSummaryMessage,
  isContextMessage,
  readV4Header,
  readV4Session,
  toModelMessage,
  type V4Message,
  type V4Session,
} from "./session-v4.js";
import type { Migration, MigrationContext } from "./types.js";

const V4_SESSIONS_DIR = "sessions";
const ARCHIVE_DIR = "sessions-v4";
const STORAGE_FILENAME = "sessions.db";
const TEMP_SUFFIX = ".importing";
const MAIN_SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}T.+_[0-9a-f]{8}\.jsonl$/i;
const ARCHIVED_THREAD_PREFIX = "scoped-archive-";
const INTERRUPTED_RESULT =
  "This tool call was interrupted by the upgrade to Pi 1.0; its outcome is unknown.";

class EntryCollector {
  readonly entries: ImportedSessionEntry[] = [];
  private readonly openCalls = new Map<string, { name: string; timestamp: number }>();

  get messageCount(): number {
    return this.entries.filter((entry) => entry.type !== "custom").length;
  }

  message(v4: V4Message): void {
    if (!isContextMessage(v4)) return;
    const message = toModelMessage(v4);
    if (!message) return;
    if (message.role === "toolResult") {
      if (!this.openCalls.delete(message.toolCallId)) return;
    } else {
      this.closeOpenCalls();
    }
    this.push(message);
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
      this.push({
        role: "toolResult",
        toolCallId,
        toolName: call.name,
        content: [{ type: "text", text: INTERRUPTED_RESULT }],
        isError: true,
        timestamp: call.timestamp,
      });
    }
    this.openCalls.clear();
  }

  private push(message: Message): void {
    this.entries.push({ type: "message", message });
  }

  private trackCalls(message: AssistantMessage): void {
    for (const part of message.content) {
      if (part.type === "toolCall") {
        this.openCalls.set(part.id, { name: part.name, timestamp: message.timestamp });
      }
    }
  }
}

function collectEntries(session: V4Session): EntryCollector {
  const collector = new EntryCollector();
  const visibleStart = session.branch.findLastIndex((entry) => entry.type === "compaction");
  for (const [index, entry] of session.branch.entries()) {
    if (entry.type === "custom") {
      collector.custom(entry.customType, entry.data, entry.timestamp);
      continue;
    }
    if (index < visibleStart) continue;
    switch (entry.type) {
      case "compaction":
        collector.compaction(entry.summary, entry.timestamp);
        for (const message of entry.retainedTail) collector.message(message);
        break;
      case "message":
        collector.message(entry.message);
        break;
      case "branch_summary":
        if (entry.summary) {
          collector.message(branchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
        }
        break;
      default:
        entry satisfies never;
    }
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
  const stem = fileName.slice(0, -".jsonl".length);
  if (MAIN_SESSION_FILENAME.test(fileName) || fileName.startsWith(ARCHIVED_THREAD_PREFIX)) {
    return { key: undefined, root: false };
  }
  return { key: makeThreadSessionKey(conversationId, stem), root: false };
}

function planOfficeImport(conversationId: string, sessionsDir: string): PlannedSession[] {
  const current = readTextFileIfExists(join(sessionsDir, "current"))?.trim() || undefined;
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .filter((entry) => readV4Header(join(sessionsDir, entry.name)) !== undefined)
    .map((entry) => {
      const file = join(sessionsDir, entry.name);
      const v4 = readV4Session(file);
      const collected = collectEntries(v4);
      const { key, root } = sessionKeyFor(conversationId, entry.name, current);
      return {
        file,
        expectedMessages: collected.messageCount,
        session: {
          key: key ?? earlierSessionKey(v4.header.id),
          id: v4.header.id,
          createdAt: v4.header.createdAt,
          root,
          name: v4.name,
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

function hasV4Sessions(sessionsDir: string): boolean {
  if (!existsSync(sessionsDir)) return false;
  return readdirSync(sessionsDir, { withFileTypes: true }).some(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      readV4Header(join(sessionsDir, entry.name)) !== undefined,
  );
}

async function migrateOffice(
  conversationId: string,
  officeDir: string,
  context: MigrationContext,
): Promise<void> {
  const sessionsDir = join(officeDir, V4_SESSIONS_DIR);
  const archive = join(officeDir, ARCHIVE_DIR);
  const storage = join(officeDir, STORAGE_FILENAME);
  const temp = `${storage}${TEMP_SUFFIX}`;
  if (!existsSync(sessionsDir) && existsSync(temp) && existsSync(archive)) {
    context.report(`  finish ${storage}`);
    if (!context.dryRun) renameSync(temp, storage);
    return;
  }
  if (!hasV4Sessions(sessionsDir)) return;
  if (existsSync(storage)) throw new Error(`Session storage already exists: ${storage}`);
  if (existsSync(archive)) throw new Error(`Archived v4 sessions already exist: ${archive}`);
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
    if (!registered.has(dir) && hasV4Sessions(join(dir, V4_SESSIONS_DIR))) {
      throw new Error(
        `Sessions in ${dir} belong to no office in office-registry.json; record the office before migrating`,
      );
    }
  }
}

export const sessionsSqliteMigration: Migration = Object.freeze({
  id: "0009-sessions-sqlite",
  summary:
    "import v4 session files into one pi-durable SQLite storage per office, keeping originals under sessions-v4/",
  async run(context: MigrationContext): Promise<void> {
    const offices = registeredOffices(context.stateDir);
    assertEveryOfficeRegistered(context.stateDir, new Set(offices.map((office) => office.dir)));
    for (const office of offices) {
      await migrateOffice(office.conversationId, office.dir, context);
    }
  },
});
