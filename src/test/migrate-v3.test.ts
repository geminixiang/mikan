import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../harness/index.js";
import { findV3SessionFiles, isV3SessionFile, migrateSessionFile } from "../sessions/migrate-v3.js";

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

    const result = await migrateSessionFile(file);
    expect(result.status).toBe("migrated");
    expect(existsSync(`${file}.v3.bak`)).toBe(true);

    const store = await SessionStore.open(file);
    expect(store.getSessionId()).toBe(header.id);
    const storeHeader = store.getHeader();
    expect(storeHeader?.parentSessionId).toBe("parent-id");
    expect(storeHeader?.parentSession).toBe("/old/parent.jsonl");
    expect(storeHeader?.timestamp).toBe(header.timestamp);

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
    const store = await SessionStore.open(file);
    const context = await store.buildSessionContext();
    expect(context.messages[0]?.role).toBe("compactionSummary");
    expect(context.messages.slice(1).map(textOf)).toEqual(["B", "C", "D"]);

    const compaction = await store.getEntry("comp");
    expect(compaction?.type).toBe("compaction");
    if (compaction?.type === "compaction") {
      expect(compaction.retainedTail.map(textOf)).toEqual(["B", "C"]);
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
    const store = await SessionStore.open(file);
    expect(await store.getSessionName()).toBe("My thread");
    const context = await store.buildSessionContext();
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]?.role).toBe("custom");
    // The custom_message's fact-only parent is skipped in the v4 chain.
    const entries = await store.getEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["a", "cm"]);
  });

  test("platform-history source marker survives into header metadata", async () => {
    const file = join(dir, "history.jsonl");
    writeJsonl(file, [
      { ...header, source: { kind: "platform-history", recentDays: 14 } },
      v3Message("a", null, "A"),
    ]);

    await migrateSessionFile(file);
    const migratedHeader = SessionStore.readHeader(file);
    expect(migratedHeader?.metadata?.source).toEqual({ kind: "platform-history", recentDays: 14 });
  });

  test("collapses crash-duplicated lines the way the v3 reader did", async () => {
    // Seen in production: a retried append duplicated the header+entry pair.
    // The v3 runtime read entries into a Map (last write wins per id), so
    // duplicates were invisible; v4 rejects duplicate mutation ids, so the
    // migration must collapse them.
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [
      header,
      v3Message("a1", null, "stale"),
      header,
      v3Message("a1", null, "latest"),
      v3Message("b2", "a1", "world", "assistant"),
    ]);

    const result = await migrateSessionFile(file);
    expect(result.status).toBe("migrated");

    const store = await SessionStore.inspect(file);
    const context = await store.buildSessionContext();
    expect(context.messages.map(textOf)).toEqual(["latest", "world"]);
  });

  test("a trailing fact-only entry re-aims the lane at its surviving ancestor", async () => {
    // Seen in production: session_info was the newest entry, so the v3 leaf
    // pointed at it — but facts do not survive as v4 entries, and the lane
    // must not reference a missing target.
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

    const result = await migrateSessionFile(file);
    expect(result.status).toBe("migrated");

    const store = await SessionStore.inspect(file);
    const context = await store.buildSessionContext();
    expect(context.messages.map(textOf)).toEqual(["hello"]);
    expect(await store.getSessionName()).toBe("titled");
  });

  test("is idempotent: a migrated file reports already-v4", async () => {
    const file = join(dir, "idempotent.jsonl");
    writeJsonl(file, [header, v3Message("a", null, "A")]);
    await migrateSessionFile(file);
    const second = await migrateSessionFile(file);
    expect(second.status).toBe("already-v4");
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
    const result = await migrateSessionFile(file, { dryRun: true });
    expect(result.status).toBe("migrated");
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(isV3SessionFile(file)).toBe(true);
  });

  test("tolerates a torn final line (crash tail) and migrates the intact prefix", async () => {
    const file = join(dir, "torn.jsonl");
    writeJsonl(file, [header, v3Message("a", null, "kept")]);
    writeFileSync(file, readFileSync(file, "utf-8") + '{"type":"message","id":"tor', "utf-8");

    const result = await migrateSessionFile(file);
    expect(result.status).toBe("migrated");

    const store = await SessionStore.inspect(file);
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

describe("unmigrated v3 sessions fail loudly", () => {
  test("current-pointer resolution throws instead of silently rotating away from a v3 session", async () => {
    const sessionDir = join(dir, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    const v3File = join(sessionDir, "2026-01-01T00-00-00-000Z_11111111.jsonl");
    writeJsonl(v3File, [header, v3Message("a", null, "history")]);
    writeFileSync(join(sessionDir, "current"), "2026-01-01T00-00-00-000Z_11111111.jsonl");

    const { tryResolveCurrentSession } = await import("../sessions/store.js");
    expect(() => tryResolveCurrentSession(sessionDir)).toThrow(/legacy v3/);
    expect(() => tryResolveCurrentSession(sessionDir)).toThrow(/mikan sessions migrate/);
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
    await SessionStore.create(join(dir, "v4.jsonl"), "/work");

    const found = findV3SessionFiles(dir);
    expect(found.toSorted()).toEqual([join(dir, "top.jsonl"), v3File].toSorted());
  });
});
