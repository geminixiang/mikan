import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../src/harness/index.js";

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

describe("SessionStore", () => {
  test("create writes a v3 header and appends persist as JSONL lines", () => {
    const file = join(dir, "session.jsonl");
    const store = SessionStore.create(file, "/work");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });

    const lines = readLines(file);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: "/work" });
    expect(lines[1]).toMatchObject({ type: "message", parentId: null });
    expect(typeof lines[1].id).toBe("string");
    expect((lines[1].id as string).length).toBe(8);
  });

  test("entries form a parent chain and getBranch returns root-first order", () => {
    const file = join(dir, "session.jsonl");
    const store = SessionStore.create(file, "/work");
    const first = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "one" }],
      timestamp: 1,
    });
    const second = store.appendCustomEntry("mikan.test", { n: 2 });

    const branch = store.getBranch();
    expect(branch.map((entry) => entry.id)).toEqual([first, second]);
    expect(branch[1].parentId).toBe(first);
    expect(store.getLeafId()).toBe(second);
  });

  test("reopens files written by earlier mikan versions (v3 format)", () => {
    const file = join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "abc-123",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/legacy",
      source: { kind: "platform-history" },
    };
    const entry = {
      type: "message",
      id: "aaaa1111",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    };
    writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);

    const store = SessionStore.open(file);
    expect(store.getSessionId()).toBe("abc-123");
    expect(store.getHeader()?.source).toEqual({ kind: "platform-history" });
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getLeafId()).toBe("aaaa1111");
    expect(store.getCwd()).toBe("/legacy");
  });

  test("buildSessionContext resolves compaction summaries", () => {
    const file = join(dir, "session.jsonl");
    const store = SessionStore.create(file, "/work");
    store.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
    const kept = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "recent" }],
      timestamp: 2,
    });
    store.appendCompaction("summary of old", kept, 1000);

    const context = store.buildSessionContext();
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

  test("open throws on a file with content but no valid header, instead of silently overwriting", () => {
    // A file whose header line is corrupted but whose message lines survive
    // must not be opened as a fresh session: the first append would rewrite
    // the file and erase the existing history. Surface the corruption instead.
    const file = join(dir, "session.jsonl");
    writeFileSync(file, 'not json\n{"type":"message","content":"kept"}\n');
    expect(() => SessionStore.open(file, "/work")).toThrow(/corrupted/i);
    // The original content is left untouched on disk.
    expect(readFileSync(file, "utf-8")).toContain("kept");
  });

  test("open treats a whitespace-only file as empty and materializes on append", () => {
    const file = join(dir, "blank.jsonl");
    writeFileSync(file, "\n  \n");
    const store = SessionStore.open(file, "/work");
    expect(store.getHeader()).toBeNull();
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
    expect(readLines(file)[0]).toMatchObject({ type: "session", version: 3 });
  });

  test("appending to a missing (headerless) file materializes the header", () => {
    const file = join(dir, "fresh.jsonl");
    const store = SessionStore.open(file, "/work");
    const sessionId = store.getSessionId();
    store.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });

    const lines = readLines(file);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, id: sessionId, cwd: "/work" });
    expect(lines).toHaveLength(2);
  });

  test("session name comes from the latest session_info entry", () => {
    const file = join(dir, "session.jsonl");
    const store = SessionStore.create(file, "/work");
    expect(store.getSessionName()).toBeUndefined();
    store.appendSessionInfo("first name");
    store.appendSessionInfo("second name");
    expect(store.getSessionName()).toBe("second name");

    const reopened = SessionStore.open(file);
    expect(reopened.getSessionName()).toBe("second name");
  });
});
