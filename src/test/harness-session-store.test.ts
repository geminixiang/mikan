import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../harness/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-session-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const legacyV3Header = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/work",
};

describe("SessionStore", () => {
  test("inMemory keeps entries without creating a session file", async () => {
    const store = SessionStore.inMemory("/work");
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "ephemeral" }],
      timestamp: 1,
    });

    expect(store.getSessionFile()).toBeUndefined();
    expect(store.isPersisted()).toBe(false);
    expect(await store.getEntries()).toHaveLength(1);
    expect((await store.buildSessionContext()).messages).toHaveLength(1);
  });

  test("create writes a v4 header and appends persist as JSONL lines", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    });

    const lines = readLines(file);
    expect(lines[0]).toMatchObject({ kind: "header", version: 4, cwd: "/work" });
    expect(typeof lines[0]?.createdAt).toBe("number");
    expect(lines[1]).toMatchObject({ kind: "entry", type: "message", parentId: null });
    expect(typeof lines[1]?.id).toBe("string");
  });

  test("entries form a parent chain and getBranch returns root-first order", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    const first = await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "one" }],
      timestamp: 1,
    });
    const second = await store.appendCustomEntry("mikan.test", { n: 2 });

    const branch = await store.getBranch();
    expect(branch.map((entry) => entry.id)).toEqual([first, second]);
    expect(branch[1]?.parentId).toBe(first);
    expect(await store.getLeafId()).toBe(second);
  });

  test("open of a legacy v3 file throws and points at the migration script", async () => {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, `${JSON.stringify(legacyV3Header)}\n`);
    const original = readFileSync(file, "utf-8");

    await expect(SessionStore.open(file)).rejects.toThrow(/legacy v3/);
    await expect(SessionStore.open(file)).rejects.toThrow(/mikan sessions migrate/);
    // The file is left untouched for the migration script.
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  test("reopen preserves session id, header metadata, entries, and cwd", async () => {
    const file = join(dir, "session.jsonl");
    SessionStore.writeHeaderFile(file, "/legacy", { id: "abc-123" });
    const seeded = await SessionStore.open(file);
    await seeded.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    });

    const store = await SessionStore.open(file);
    expect(store.getSessionId()).toBe("abc-123");
    expect(store.getHeader()).toMatchObject({ type: "session", id: "abc-123", cwd: "/legacy" });
    expect(await store.getEntries()).toHaveLength(1);
    expect(await store.getLeafId()).toBe((await store.getEntries())[0]?.id);
    expect(store.getCwd()).toBe("/legacy");
  });

  test("readHeader returns a v3-flavored view, null for absent files, and throws for v3", () => {
    expect(SessionStore.readHeader(join(dir, "missing.jsonl"))).toBeNull();

    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "\n  \n");
    expect(SessionStore.readHeader(empty)).toBeNull();

    const v4 = join(dir, "v4.jsonl");
    SessionStore.writeHeaderFile(v4, "/work", { id: "id-1" });
    expect(SessionStore.readHeader(v4)).toMatchObject({
      type: "session",
      version: 4,
      id: "id-1",
      cwd: "/work",
    });
    expect(typeof SessionStore.readHeader(v4)?.timestamp).toBe("string");

    const v3 = join(dir, "v3.jsonl");
    writeFileSync(v3, `${JSON.stringify(legacyV3Header)}\n`);
    expect(() => SessionStore.readHeader(v3)).toThrow(/legacy v3/);
  });

  test("buildSessionContext resolves compaction summaries", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old" }],
      timestamp: 1,
    });
    const kept = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "recent" }],
      timestamp: 2,
    };
    await store.appendMessage(kept);
    await store.appendCompaction("summary of old", [kept], 1000);

    const context = await store.buildSessionContext();
    const rendered = context.messages
      .map((message) => {
        if ("summary" in message && typeof message.summary === "string") return message.summary;
        if ("content" in message && Array.isArray(message.content)) {
          return message.content.map((part) => ("text" in part ? part.text : "")).join("");
        }
        return "";
      })
      .join("|");
    expect(rendered).toContain("summary of old");
    expect(rendered).toContain("recent");
    expect(rendered).not.toMatch(/(^|\|)old($|\|)/);
  });

  test("open throws on a file with content but no valid header, instead of silently overwriting", async () => {
    // A file whose header line is corrupted but whose message lines survive
    // must not be opened as a fresh session: the first append would rewrite
    // the file and erase the existing history. Surface the problem instead.
    const notJson = join(dir, "not-json.jsonl");
    writeFileSync(notJson, 'not json\n{"kind":"entry","content":"kept"}\n');
    await expect(SessionStore.open(notJson, "/work")).rejects.toThrow(/not valid JSON/i);
    // The original content is left untouched on disk.
    expect(readFileSync(notJson, "utf-8")).toContain("kept");

    const wrongShape = join(dir, "wrong-shape.jsonl");
    writeFileSync(wrongShape, '{"hello":"world"}\n');
    await expect(SessionStore.open(wrongShape, "/work")).rejects.toThrow(/unrecognized header/i);
  });

  test("open treats a whitespace-only file as empty and materializes on append", async () => {
    const file = join(dir, "blank.jsonl");
    writeFileSync(file, "\n  \n");
    const store = await SessionStore.open(file, "/work");
    // Nothing is written until the first append.
    expect(readFileSync(file, "utf-8").trim()).toBe("");
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    });
    expect(readLines(file)[0]).toMatchObject({ kind: "header", version: 4 });
  });

  test("appending to a missing (headerless) file materializes the header", async () => {
    const file = join(dir, "fresh.jsonl");
    const store = await SessionStore.open(file, "/work");
    const sessionId = store.getSessionId();
    expect(existsSync(file)).toBe(false);
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    });

    const lines = readLines(file);
    expect(lines[0]).toMatchObject({ kind: "header", version: 4, id: sessionId, cwd: "/work" });
    expect(lines).toHaveLength(2);
  });

  test("session name comes from the latest set name", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    expect(await store.getSessionName()).toBeUndefined();
    await store.setSessionName("first name");
    await store.setSessionName("second name");
    expect(await store.getSessionName()).toBe("second name");

    const reopened = await SessionStore.open(file);
    expect(await reopened.getSessionName()).toBe("second name");
  });
});
