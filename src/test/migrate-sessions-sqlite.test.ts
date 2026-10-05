import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sessionsSqliteMigration } from "../migrations/sessions-sqlite.js";
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

const MAIN = "2026-01-01T00-00-00-000Z_aaaaaaaa.jsonl";

function at(second: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
}

function header(id: string): Record<string, unknown> {
  return { type: "session", version: 3, id, timestamp: at(0), cwd: "/workspace/C1" };
}

function message(id: string, parentId: string | null, role: string, content: unknown) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: at(Number(id.replace(/\D/g, "") || 1)),
    message: { role, content, timestamp: 1 },
  };
}

function user(id: string, parentId: string | null, text: string) {
  return message(id, parentId, "user", [{ type: "text", text }]);
}

function lines(records: readonly unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function writeV3(name: string, records: readonly unknown[]): string {
  const file = join(sessionsDir, name);
  writeFileSync(file, lines(records));
  return file;
}

function textOf(value: { content: unknown }): string {
  return Array.isArray(value.content)
    ? value.content.map((part: { text?: string }) => part.text ?? "").join("")
    : String(value.content);
}

async function inspect(key: string) {
  const inspection = await SessionStore.inspect(office, key);
  if (!inspection) throw new Error(`missing session ${key}`);
  return inspection;
}

async function contextTexts(key: string): Promise<string[][]> {
  const { messages } = await (await inspect(key)).buildSessionContext();
  return messages.map((entry) => [entry.role, textOf(entry)]);
}

test("imports each 0.5.3 session's visible context into the office storage and archives the originals", async () => {
  const main = writeV3(MAIN, [
    header("main-1"),
    {
      type: "model_change",
      id: "m0",
      parentId: null,
      timestamp: at(1),
      provider: "p",
      modelId: "x",
    },
    user("u1", "m0", "hidden"),
    {
      type: "custom",
      id: "s2",
      parentId: "u1",
      timestamp: at(2),
      customType: "mikan.chat_sync",
      data: { lastMessageId: "9" },
    },
    user("u3", "s2", "kept"),
    message("a4", "u3", "assistant", [{ type: "text", text: "old answer" }]),
    {
      type: "compaction",
      id: "c5",
      parentId: "a4",
      timestamp: at(5),
      summary: "earlier work",
      firstKeptEntryId: "u3",
      tokensBefore: 100,
    },
    user("u6", "c5", "latest"),
    {
      type: "message",
      id: "a7",
      parentId: "u6",
      timestamp: at(7),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
        stopReason: "toolUse",
        timestamp: 7,
      },
    },
    { type: "session_info", id: "i8", parentId: "a7", timestamp: at(8), name: " Imported " },
  ]);
  writeFileSync(join(sessionsDir, "current"), MAIN);
  writeV3("1000.1.jsonl", [header("thread-1"), user("u1", null, "in thread")]);
  writeV3("2025-12-01T00-00-00-000Z_bbbbbbbb.jsonl", [
    header("earlier-1"),
    user("u1", null, "before /new"),
  ]);
  const original = readFileSync(main, "utf-8");

  await sessionsSqliteMigration.run(context(true));
  expect(existsSync(office.sessionsPath)).toBe(false);
  expect(readFileSync(main, "utf-8")).toBe(original);

  await sessionsSqliteMigration.run(context());

  expect(existsSync(sessionsDir)).toBe(false);
  expect(readFileSync(join(office.stateDir, "sessions-v3", MAIN), "utf-8")).toBe(original);
  const listing = await SessionStore.list(office);
  expect(listing.map((session) => [session.key, session.id, session.root]).toSorted()).toEqual([
    ["C1", "main-1", true],
    ["C1:1000.1", "thread-1", false],
    [earlierSessionKey("earlier-1"), "earlier-1", false],
  ]);

  const channel = await inspect("C1");
  expect(await channel.getSessionName()).toBe("Imported");
  const { messages } = await channel.buildSessionContext();
  expect(compactionSummaryOf(messages[0]!)).toBe("earlier work");
  expect(messages.slice(1).map((entry) => [entry.role, textOf(entry)])).toEqual([
    ["user", "kept"],
    ["assistant", "old answer"],
    ["user", "latest"],
    ["assistant", ""],
    ["toolResult", expect.stringContaining("interrupted by the upgrade")],
  ]);
  expect(JSON.stringify(messages)).not.toContain("hidden");
  const entries = await channel.getEntries();
  expect(entries).toContainEqual(
    expect.objectContaining({ customType: "mikan.chat_sync", data: { lastMessageId: "9" } }),
  );
  expect(entries).toContainEqual(
    expect.objectContaining({
      customType: "mikan.legacy.model_change",
      data: { provider: "p", modelId: "x" },
    }),
  );
  expect(await contextTexts("C1:1000.1")).toEqual([["user", "in thread"]]);

  const before = reports.length;
  await sessionsSqliteMigration.run(context());
  expect(reports).toHaveLength(before);
});

test("a custom message enters the context as a user message", async () => {
  writeV3("1000.1.jsonl", [
    header("thread-1"),
    user("u1", null, "A"),
    {
      type: "custom_message",
      id: "n2",
      parentId: "u1",
      timestamp: at(2),
      customType: "note",
      content: "remember this",
      display: false,
    },
  ]);

  await sessionsSqliteMigration.run(context());

  expect(await contextTexts("C1:1000.1")).toEqual([
    ["user", "A"],
    ["user", "remember this"],
  ]);
});

test("reads a file the way the 0.5.3 reader did: last duplicate wins and a torn tail is dropped", async () => {
  const file = writeV3("1000.1.jsonl", [
    header("thread-1"),
    user("u1", null, "stale"),
    header("thread-1"),
    user("u1", null, "latest"),
    message("a2", "u1", "assistant", [{ type: "text", text: "world" }]),
  ]);
  writeFileSync(file, `${readFileSync(file, "utf-8")}{"type":"message","id":"tor`);

  await sessionsSqliteMigration.run(context());

  expect(await contextTexts("C1:1000.1")).toEqual([
    ["user", "latest"],
    ["assistant", "world"],
  ]);
});

test("invalid JSON before the last line fails and leaves the files in place", async () => {
  const file = join(sessionsDir, "1000.1.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify(header("thread-1"))}\n{ not json\n${JSON.stringify(user("u1", null, "A"))}\n`,
  );

  await expect(sessionsSqliteMigration.run(context())).rejects.toThrow(/line 2/);

  expect(existsSync(file)).toBe(true);
  expect(existsSync(office.sessionsPath)).toBe(false);
  expect(existsSync(`${office.sessionsPath}.importing`)).toBe(false);
});

test("an interrupted publish finishes on the next run", async () => {
  writeV3("1000.1.jsonl", [header("thread-1"), user("u1", null, "hello")]);
  await sessionsSqliteMigration.run(context());
  const storage = office.sessionsPath;
  writeFileSync(`${storage}.importing`, readFileSync(storage));
  rmSync(storage);

  await sessionsSqliteMigration.run(context());

  expect(existsSync(`${storage}.importing`)).toBe(false);
  expect(await contextTexts("C1:1000.1")).toEqual([["user", "hello"]]);
});

test("refuses sessions of an office the registry does not know", async () => {
  const stray = join(stateDir, "conversations", "v1-slack-stray", "sessions");
  mkdirSync(stray, { recursive: true });
  writeFileSync(join(stray, "1000.1.jsonl"), lines([header("stray")]));

  await expect(sessionsSqliteMigration.run(context())).rejects.toThrow("office-registry.json");
});
