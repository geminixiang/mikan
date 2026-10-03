import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { sessionsSqliteMigration } from "../migrations/sessions-sqlite.js";
import { V4FileWriter } from "../migrations/session-files.js";
import type { MigrationContext } from "../migrations/types.js";
import { OfficeRegistry, createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { compactionSummaryOf } from "../sessions/compaction-summary.js";
import { SessionStore, earlierSessionKey } from "../sessions/session-store.js";

let stateDir: string;
let office: Office;
let sessionsDir: string;
let reports: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-migrate-sqlite-"));
  const address = createOfficeAddress("slack", "C1");
  new OfficeRegistry(stateDir).recordOffice(address);
  office = createWorkspace({ root: join(stateDir, "workspace"), stateDir }).office(address);
  sessionsDir = join(office.stateDir, "sessions");
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

function writeV4(name: string, id: string, build: (writer: V4FileWriter) => void): string {
  const writer = new V4FileWriter({
    v: 4,
    kind: "header",
    id,
    storageVersion: 1,
    createdAt: 1_000,
    cwd: "/workspace",
  });
  build(writer);
  const file = join(sessionsDir, name);
  writeFileSync(file, writer.toString());
  return file;
}

function oneMessage(text: string) {
  return (writer: V4FileWriter) => {
    writer.entry({
      type: "message",
      id: "a",
      parentId: null,
      timestamp: 1,
      message: user(text, 1),
    });
    writer.set("pi.branch.tip", "main", "a");
  };
}

function textOf(message: { content: unknown }): string {
  return Array.isArray(message.content)
    ? message.content.map((part: { text?: string }) => part.text ?? "").join("")
    : String(message.content);
}

async function contextOf(key: string) {
  const inspection = await SessionStore.inspect(office, key);
  if (!inspection) throw new Error(`missing session ${key}`);
  return inspection;
}

test("imports each v4 session's visible context into the office storage and archives the originals", async () => {
  const call = fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }), {
    stopReason: "toolUse",
  });
  call.timestamp = 5;
  const main = writeV4("2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl", "main-1", (writer) => {
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
      retainedTail: [user("kept", 3), fauxAssistantMessage("old answer")],
      tokensBefore: 100,
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
  });
  writeFileSync(join(sessionsDir, "current"), "2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl");
  writeV4("1000.1.jsonl", "thread-1", oneMessage("in thread"));
  writeV4("2025-12-01T00-00-00-000Z_bbbbbbbb.jsonl", "earlier-1", oneMessage("before /new"));
  const original = readFileSync(main, "utf-8");

  await sessionsSqliteMigration.run(context(true));
  expect(existsSync(office.sessionsPath)).toBe(false);
  expect(readFileSync(main, "utf-8")).toBe(original);

  await sessionsSqliteMigration.run(context());

  expect(existsSync(sessionsDir)).toBe(false);
  expect(
    readFileSync(
      join(office.stateDir, "sessions-v4", "2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl"),
      "utf-8",
    ),
  ).toBe(original);
  const listing = await SessionStore.list(office);
  expect(listing.map((session) => [session.key, session.id, session.root]).toSorted()).toEqual([
    ["C1", "main-1", true],
    ["C1:1000.1", "thread-1", false],
    [earlierSessionKey("earlier-1"), "earlier-1", false],
  ]);

  const channel = await contextOf("C1");
  expect(await channel.getSessionName()).toBe("Imported");
  const { messages } = await channel.buildSessionContext();
  expect(compactionSummaryOf(messages[0]!)).toBe("earlier work");
  expect(messages.slice(1).map((message) => [message.role, textOf(message)])).toEqual([
    ["user", "kept"],
    ["assistant", "old answer"],
    ["user", "latest"],
    ["assistant", ""],
    ["toolResult", expect.stringContaining("interrupted by the upgrade")],
  ]);
  expect(messages.at(-1)?.timestamp).toBe(5);
  expect(JSON.stringify(messages)).not.toContain("hidden");
  expect(await channel.getEntries()).toContainEqual(
    expect.objectContaining({ customType: "mikan.chat_sync", data: { lastMessageId: "9" } }),
  );
  expect(textOf((await (await contextOf("C1:1000.1")).buildSessionContext()).messages[0]!)).toBe(
    "in thread",
  );

  const before = reports.length;
  await sessionsSqliteMigration.run(context());
  expect(reports).toHaveLength(before);
});

test("an interrupted publish finishes on the next run", async () => {
  writeV4("1000.1.jsonl", "thread-1", oneMessage("hello"));
  await sessionsSqliteMigration.run(context());
  const storage = office.sessionsPath;
  writeFileSync(`${storage}.importing`, readFileSync(storage));
  rmSync(storage);

  await sessionsSqliteMigration.run(context());

  expect(existsSync(`${storage}.importing`)).toBe(false);
  expect(textOf((await (await contextOf("C1:1000.1")).buildSessionContext()).messages[0]!)).toBe(
    "hello",
  );
});

test("refuses sessions of an office the registry does not know", async () => {
  const stray = join(stateDir, "conversations", "v1-slack-stray", "sessions");
  mkdirSync(stray, { recursive: true });
  const writer = new V4FileWriter({
    v: 4,
    kind: "header",
    id: "stray",
    storageVersion: 1,
    createdAt: 1,
    cwd: "/",
  });
  writeFileSync(join(stray, "1000.1.jsonl"), writer.toString());

  await expect(sessionsSqliteMigration.run(context())).rejects.toThrow("office-registry.json");
});
