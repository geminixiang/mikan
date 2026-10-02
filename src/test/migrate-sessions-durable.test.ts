import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { sessionsDurableMigration } from "../migrations/sessions-durable.js";
import { V4FileWriter } from "../migrations/session-files.js";
import type { MigrationContext } from "../migrations/types.js";
import { compactionSummaryOf } from "../sessions/compaction-summary.js";
import { SessionStore, sessionStorageDir } from "../sessions/session-store.js";

let stateDir: string;
let sessionsDir: string;
let reports: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-migrate-durable-"));
  sessionsDir = join(stateDir, "conversations", "v1-slack-c1", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  reports = [];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function context(dryRun = false): MigrationContext {
  return {
    workspaceRoot: join(stateDir, "workspace"),
    stateDir,
    dryRun,
    owners: new Map(),
    enabledPlatforms: ["slack"],
    sandbox: { type: "host" },
    piAgentDir: join(stateDir, "pi"),
    modelsPath: join(stateDir, "models.json"),
    docker: async () => "",
    report: (line) => {
      reports.push(line);
    },
  };
}

function user(text: string, timestamp: number) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

function writeV4(file: string, build: (writer: V4FileWriter) => void): void {
  const writer = new V4FileWriter({
    v: 4,
    kind: "header",
    id: "session-1",
    storageVersion: 1,
    createdAt: 1_000,
    cwd: "/workspace",
    parentSessionId: "parent-1",
  });
  build(writer);
  writeFileSync(file, writer.toString());
}

function textOf(message: { content: unknown }): string {
  return Array.isArray(message.content)
    ? message.content.map((part: { text?: string }) => part.text ?? "").join("")
    : String(message.content);
}

test("imports the visible v4 context, bookkeeping, and name, and archives the original", async () => {
  const file = join(sessionsDir, "2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl");
  const answered = fauxAssistantMessage("old answer");
  const call = fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }), {
    stopReason: "toolUse",
  });
  writeV4(file, (writer) => {
    writer.entry({
      type: "message",
      id: "a",
      parentId: null,
      timestamp: 1,
      message: user("hidden", 1),
    });
    writer.entry({
      type: "custom",
      id: "b",
      parentId: "a",
      timestamp: 2,
      customType: "mikan.chat_sync",
      data: { lastMessageId: "9" },
    });
    writer.entry({
      type: "compaction",
      id: "c",
      parentId: "b",
      timestamp: 3,
      summary: "earlier work",
      retainedTail: [user("kept", 3), answered],
      tokensBefore: 100,
      fromHook: false,
    });
    writer.entry({
      type: "message",
      id: "d",
      parentId: "c",
      timestamp: 4,
      message: user("latest", 4),
    });
    writer.entry({ type: "message", id: "e", parentId: "d", timestamp: 5, message: call });
    writer.set("pi.branch.tip", "main", "e");
    writer.set("pi.session.name", "", "Imported");
    writer.set("mikan", "metadata", { source: { kind: "platform-history" } });
  });
  const original = readFileSync(file, "utf-8");

  await sessionsDurableMigration.run(context(true));
  expect(readFileSync(file, "utf-8")).toBe(original);

  await sessionsDurableMigration.run(context());

  const archive = join(
    stateDir,
    "conversations",
    "v1-slack-c1",
    "sessions-v4",
    "2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl",
  );
  expect(readFileSync(archive, "utf-8")).toBe(original);
  expect(existsSync(sessionStorageDir(file))).toBe(true);
  expect(SessionStore.readHeader(file)).toMatchObject({
    id: "session-1",
    parentSessionId: "parent-1",
    source: { kind: "platform-history" },
  });
  const inspection = await SessionStore.inspect(file);
  expect(await inspection.getSessionName()).toBe("Imported");
  const { messages } = await inspection.buildSessionContext();
  expect(compactionSummaryOf(messages[0]!)).toBe("earlier work");
  expect(
    (await inspection.getEntries()).find((entry) => entry.type === "compaction"),
  ).toMatchObject({ summary: "earlier work" });
  expect(messages.slice(1).map((message) => [message.role, textOf(message)])).toEqual([
    ["user", "kept"],
    ["assistant", "old answer"],
    ["user", "latest"],
    ["assistant", ""],
    ["toolResult", expect.stringContaining("interrupted by the upgrade")],
  ]);
  expect(JSON.stringify(messages)).not.toContain("hidden");
  const entries = await inspection.getEntries();
  expect(entries).toContainEqual(
    expect.objectContaining({
      type: "custom",
      customType: "mikan.chat_sync",
      data: { lastMessageId: "9" },
    }),
  );

  const before = reports.length;
  await sessionsDurableMigration.run(context());
  expect(reports).toHaveLength(before);
});

test("an interrupted publish finishes on the next run", async () => {
  const file = join(sessionsDir, "thread.jsonl");
  writeV4(file, (writer) => {
    writer.entry({
      type: "message",
      id: "a",
      parentId: null,
      timestamp: 1,
      message: user("hello", 1),
    });
    writer.set("pi.branch.tip", "main", "a");
  });
  const store = await SessionStore.create(`${file}.importing`, { id: "session-1" });
  await store.appendMessage(user("hello", 1));
  await store.close();
  const archive = join(stateDir, "conversations", "v1-slack-c1", "sessions-v4", "thread.jsonl");
  mkdirSync(join(archive, ".."), { recursive: true });
  writeFileSync(archive, readFileSync(file));
  rmSync(file);

  await sessionsDurableMigration.run(context());

  const inspection = await SessionStore.inspect(file);
  expect((await inspection.buildSessionContext()).messages.map(textOf)).toEqual(["hello"]);
  expect(existsSync(`${file}.importing`)).toBe(false);
});
