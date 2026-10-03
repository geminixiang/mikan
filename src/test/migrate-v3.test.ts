import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openSessionAt } from "./session-context.js";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildV4Context, readV4Session } from "../migrations/session-v4.js";

function openV4(file: string) {
  const session = readV4Session(file);
  return {
    getSessionId: () => session.header.id,
    getHeader: () => ({
      parentSessionId: session.header.parentSessionId,
      createdAt: session.header.createdAt,
      source: session.source,
    }),
    getEntries: async () => session.branch,
    getEntry: async (id: string) => session.branch.find((entry) => entry.id === id),
    getSessionName: async () => session.name,
    buildSessionContext: async () => ({ messages: buildV4Context(session.branch) }),
  };
}
import {
  findV3SessionFiles,
  isV3SessionFile,
  migrateSessionFile,
} from "../migrations/sessions-v3.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-migrate-v3-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(file: string, records: Record<string, unknown>[]): void {
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const header = {
  type: "session",
  version: 3,
  id: "11111111-2222-3333-4444-555555555555",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/work",
};

function v3Message(id: string, parentId: string | null, text: string, role = "user") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 1 },
  };
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      (part as { type?: string }).type === "text" ? (part as { text: string }).text : "",
    )
    .join("");
}

describe("migrateSessionFile", () => {
  test("migrates a linear v3 session and preserves ids, context, and header lineage", async () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [
      { ...header, parentSession: "/old/parent.jsonl", parentSessionId: "parent-id" },
      v3Message("a1", null, "hello"),
      v3Message("b2", "a1", "world", "assistant"),
    ]);

    await expect(migrateSessionFile(file)).resolves.toBeUndefined();
    expect(existsSync(`${file}.v3.bak`)).toBe(true);
    const records = readFileSync(file, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.slice(1, 3)).toMatchObject([{ seq: 1 }, { seq: 2 }]);

    const store = openV4(file);
    expect(store.getSessionId()).toBe(header.id);
    const storeHeader = store.getHeader();
    expect(storeHeader?.parentSessionId).toBe("parent-id");
    expect(storeHeader?.createdAt).toBe(Date.parse(header.timestamp));

    const entries = await store.getEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["a1", "b2"]);
    expect(entries[0]?.timestamp).toBe(Date.parse("2026-01-01T00:00:01.000Z"));

    const context = await store.buildSessionContext();
    expect(context.messages.map(textOf)).toEqual(["hello", "world"]);
  });

  test("compaction firstKeptEntryId becomes an inline retainedTail with identical context", async () => {
    const file = join(dir, "compaction.jsonl");
    writeJsonl(file, [
      header,
      v3Message("a", null, "A"),
      v3Message("b", "a", "B"),
      v3Message("c", "b", "C"),
      {
        type: "compaction",
        id: "comp",
        parentId: "c",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "the summary",
        firstKeptEntryId: "b",
        tokensBefore: 100,
      },
      v3Message("d", "comp", "D"),
    ]);

    await migrateSessionFile(file);
    const store = openV4(file);
    const context = await store.buildSessionContext();
    expect(context.messages[0]?.role).toBe("compactionSummary");
    expect(context.messages.slice(1).map(textOf)).toEqual(["B", "C", "D"]);

    const compaction = await store.getEntry("comp");
    expect(compaction?.type).toBe("compaction");
    if (compaction?.type === "compaction") {
      expect(compaction.retainedTail.map(textOf)).toEqual(["B", "C"]);
      expect(compaction).not.toHaveProperty("fromHook");
      expect(readFileSync(file, "utf-8")).not.toContain("fromHook");
    }
  });

  test("session_info becomes the v4 name and custom_message keeps participating in context", async () => {
    const file = join(dir, "extras.jsonl");
    writeJsonl(file, [
      header,
      v3Message("a", null, "A"),
      {
        type: "session_info",
        id: "info",
        parentId: "a",
        timestamp: "2026-01-01T00:00:02.000Z",
        name: "My thread",
      },
      {
        type: "custom_message",
        id: "cm",
        parentId: "info",
        timestamp: "2026-01-01T00:00:03.000Z",
        customType: "note",
        content: "remember this",
        display: false,
      },
    ]);

    await migrateSessionFile(file);
    const store = openV4(file);
    expect(await store.getSessionName()).toBe("My thread");
    const context = await store.buildSessionContext();
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]?.role).toBe("custom");
    const entries = await store.getEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["a", "cm"]);
  });

  test("platform-history source marker survives into the header", async () => {
    const file = join(dir, "history.jsonl");
    writeJsonl(file, [
      { ...header, source: { kind: "platform-history", recentDays: 14 } },
      v3Message("a", null, "A"),
    ]);

    await migrateSessionFile(file);
    const migratedHeader = openV4(file).getHeader();
    expect(migratedHeader?.source).toEqual({
      kind: "platform-history",
      recentDays: 14,
    });
  });

  test("collapses crash-duplicated lines the way the v3 reader did", async () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [
      header,
      v3Message("a1", null, "stale"),
      header,
      v3Message("a1", null, "latest"),
      v3Message("b2", "a1", "world", "assistant"),
    ]);

    await migrateSessionFile(file);

    const store = openV4(file);
    const context = await store.buildSessionContext();
    expect(context.messages.map(textOf)).toEqual(["latest", "world"]);
  });

  test("a trailing fact-only entry re-aims the lane at its surviving ancestor", async () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [
      header,
      v3Message("a1", null, "hello"),
      {
        type: "session_info",
        id: "f1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:02.000Z",
        name: "titled",
      },
    ]);

    await migrateSessionFile(file);

    const store = openV4(file);
    const context = await store.buildSessionContext();
    expect(context.messages.map(textOf)).toEqual(["hello"]);
    expect(await store.getSessionName()).toBe("titled");
  });

  test("is idempotent: a migrated file and backup stay unchanged", async () => {
    const file = join(dir, "idempotent.jsonl");
    writeJsonl(file, [header, v3Message("a", null, "A")]);
    await migrateSessionFile(file);
    const migrated = readFileSync(file, "utf-8");
    const backup = readFileSync(`${file}.v3.bak`, "utf-8");
    await migrateSessionFile(file);
    expect(readFileSync(file, "utf-8")).toBe(migrated);
    expect(readFileSync(`${file}.v3.bak`, "utf-8")).toBe(backup);
  });

  test("refuses to overwrite an existing backup", async () => {
    const file = join(dir, "backup.jsonl");
    writeJsonl(file, [header, v3Message("a", null, "A")]);
    writeFileSync(`${file}.v3.bak`, "existing backup");

    await expect(migrateSessionFile(file)).rejects.toThrow(/Backup already exists/);
    expect(isV3SessionFile(file)).toBe(true);
    expect(readFileSync(`${file}.v3.bak`, "utf8")).toBe("existing backup");
  });

  test("dry run leaves the file untouched", async () => {
    const file = join(dir, "dry.jsonl");
    writeJsonl(file, [header, v3Message("a", null, "A")]);
    const before = readFileSync(file, "utf-8");
    await migrateSessionFile(file, { dryRun: true });
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(isV3SessionFile(file)).toBe(true);
  });

  test("tolerates a torn final line (crash tail) and migrates the intact prefix", async () => {
    const file = join(dir, "torn.jsonl");
    writeJsonl(file, [header, v3Message("a", null, "kept")]);
    writeFileSync(file, readFileSync(file, "utf-8") + '{"type":"message","id":"tor', "utf-8");

    await migrateSessionFile(file);

    const store = openV4(file);
    const context = await store.buildSessionContext();
    expect(context.messages.map(textOf)).toEqual(["kept"]);
  });

  test("invalid JSON before the tail fails loudly and leaves the file untouched", async () => {
    const file = join(dir, "corrupt.jsonl");
    const lines = [
      JSON.stringify(header),
      "{ not json at all",
      JSON.stringify(v3Message("a", null, "A")),
    ];
    writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
    const before = readFileSync(file, "utf-8");

    await expect(migrateSessionFile(file)).rejects.toThrow(/Invalid JSON on line 2/);
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(existsSync(`${file}.v3.bak`)).toBe(false);
    expect(existsSync(`${file}.v4.tmp`)).toBe(false);
  });
});

describe("findV3SessionFiles", () => {
  test("finds v3 files recursively and skips v4 and non-session files", async () => {
    const nested = join(dir, "office", "sessions");
    mkdirSync(nested, { recursive: true });
    const v3File = join(nested, "thread.jsonl");
    writeJsonl(join(dir, "top.jsonl"), [header, v3Message("a", null, "A")]);
    writeJsonl(v3File, [{ ...header, id: "99999999-2222-3333-4444-555555555555" }]);
    writeFileSync(join(dir, "notes.txt"), "not a session");
    await openSessionAt(join(dir, "v4.jsonl"));

    const found = findV3SessionFiles(dir);
    expect(found.toSorted()).toEqual([join(dir, "top.jsonl"), v3File].toSorted());
  });
});
