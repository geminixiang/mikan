import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionStore, sessionStorageDir } from "../sessions/session-store.js";
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

const TEMP_SUFFIX = ".importing";
const ARCHIVE_DIR = "sessions-v4";
const INTERRUPTED_RESULT =
  "This tool call was interrupted by the upgrade to Pi 1.0; its outcome is unknown.";

function archivePath(file: string): string {
  const marker = `${sep}sessions${sep}`;
  const index = file.lastIndexOf(marker);
  if (index < 0) throw new Error(`Session file is not inside a sessions directory: ${file}`);
  const office = file.slice(0, index);
  const sessionsRoot = file.slice(0, index + marker.length - 1);
  return join(office, ARCHIVE_DIR, relative(sessionsRoot, file));
}

function finishPublish(file: string, temp: string): void {
  renameSync(sessionStorageDir(temp), sessionStorageDir(file));
  renameSync(temp, file);
}

class SessionImporter {
  private readonly openCalls = new Map<string, string>();
  private messages = 0;

  constructor(private readonly store: SessionStore) {}

  get importedMessages(): number {
    return this.messages;
  }

  async append(message: V4Message): Promise<void> {
    if (!isContextMessage(message)) return;
    const model = toModelMessage(message);
    if (!model) return;
    if (model.role === "toolResult") {
      if (!this.openCalls.delete(model.toolCallId)) return;
    } else {
      await this.closeOpenCalls();
    }
    await this.store.appendMessage(model);
    this.messages += 1;
    if (model.role === "assistant") this.trackCalls(model);
  }

  async closeOpenCalls(): Promise<void> {
    for (const [toolCallId, toolName] of this.openCalls) {
      await this.store.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: INTERRUPTED_RESULT }],
        isError: true,
        timestamp: Date.now(),
      });
      this.messages += 1;
    }
    this.openCalls.clear();
  }

  private trackCalls(message: AssistantMessage): void {
    for (const part of message.content) {
      if (part.type === "toolCall") this.openCalls.set(part.id, part.name);
    }
  }
}

async function importSession(session: V4Session, temp: string): Promise<number> {
  const store = await SessionStore.create(temp, {
    id: session.header.id,
    parentSessionId: session.header.parentSessionId,
    source: session.source,
  });
  try {
    const importer = new SessionImporter(store);
    const visibleStart = session.branch.findLastIndex((entry) => entry.type === "compaction");
    for (const [index, entry] of session.branch.entries()) {
      if (entry.type === "custom") {
        await store.appendCustomEntry(entry.customType, entry.data, entry.timestamp);
        continue;
      }
      if (index < visibleStart) continue;
      switch (entry.type) {
        case "compaction":
          await importer.closeOpenCalls();
          await store.appendCompactionSummary(entry.summary, entry.timestamp);
          for (const message of entry.retainedTail) await importer.append(message);
          break;
        case "message":
          await importer.append(entry.message);
          break;
        case "branch_summary":
          if (entry.summary) {
            await importer.append(
              branchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
            );
          }
          break;
        default:
          entry satisfies never;
      }
    }
    await importer.closeOpenCalls();
    if (session.name) await store.setSessionName(session.name);
    return importer.importedMessages;
  } finally {
    await store.close();
  }
}

async function verifyImport(temp: string, expectedMessages: number): Promise<void> {
  const inspection = await SessionStore.inspect(temp);
  const { messages } = await inspection.buildSessionContext();
  if (messages.length < expectedMessages) {
    throw new Error(
      `imported context has ${messages.length} messages; expected at least ${expectedMessages}`,
    );
  }
}

async function migrateV4SessionFile(file: string, context: MigrationContext): Promise<void> {
  const temp = `${file}${TEMP_SUFFIX}`;
  const archive = archivePath(file);
  if (!existsSync(file) && existsSync(temp) && existsSync(archive)) {
    if (!context.dryRun) finishPublish(file, temp);
    return;
  }
  const session = readV4Session(file);
  if (session.open) context.report(`    interrupted run in ${file} is not resumed`);
  if (context.dryRun) return;
  if (existsSync(archive)) throw new Error(`Archived v4 session already exists: ${archive}`);
  rmSync(temp, { force: true });
  rmSync(sessionStorageDir(temp), { recursive: true, force: true });
  try {
    const imported = await importSession(session, temp);
    await verifyImport(temp, imported);
  } catch (error) {
    rmSync(temp, { force: true });
    rmSync(sessionStorageDir(temp), { recursive: true, force: true });
    throw new Error(`Session migration failed for ${file}`, { cause: error });
  }
  mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  renameSync(file, archive);
  finishPublish(file, temp);
}

function collectPending(dir: string, found: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name !== ARCHIVE_DIR && !entry.name.endsWith(".durable")) {
        collectPending(path, found);
      }
    } else if (entry.name.endsWith(`.jsonl${TEMP_SUFFIX}`)) {
      found.add(path.slice(0, -TEMP_SUFFIX.length));
    } else if (entry.name.endsWith(".jsonl") && readV4Header(path) !== undefined) {
      found.add(path);
    }
  }
}

function pendingFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found = new Set<string>();
  collectPending(root, found);
  return [...found].toSorted();
}

export const sessionsDurableMigration: Migration = Object.freeze({
  id: "0009-sessions-durable",
  summary: "import v4 session files into Pi durable storage, keeping originals under sessions-v4/",
  async run(context: MigrationContext): Promise<void> {
    for (const file of pendingFiles(join(context.stateDir, "conversations"))) {
      context.report(`  session ${file}`);
      await migrateV4SessionFile(file, context);
    }
  },
});
