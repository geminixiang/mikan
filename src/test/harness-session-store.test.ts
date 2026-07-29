import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

const validHeader = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/work",
};

function makeEntry(
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "test",
    ...extra,
  };
}

function writeJsonl(file: string, records: Record<string, unknown>[]): void {
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("SessionStore", () => {
  test("inMemory keeps entries without creating a session file", () => {
    const store = SessionStore.inMemory("/work");
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "ephemeral" }],
      timestamp: 1,
    });

    expect(store.getSessionFile()).toBeUndefined();
    expect(store.isPersisted()).toBe(false);
    expect(store.getEntries()).toHaveLength(1);
    expect(store.buildSessionContext().messages).toHaveLength(1);
  });

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

  test("recovers a malformed final crash tail without changing the file until append", () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [validHeader, makeEntry("root", null)]);
    writeFileSync(file, `${readFileSync(file, "utf-8")}{"type":"message"`);
    const original = readFileSync(file, "utf-8");

    const store = SessionStore.open(file);
    expect(store.getEntries().map(({ id }) => id)).toEqual(["root"]);
    expect(readFileSync(file, "utf-8")).toBe(original);

    store.appendCustomEntry("after-crash");
    const lines = readLines(file);
    expect(lines.map(({ id }) => id).filter(Boolean)).toEqual([
      "session-1",
      "root",
      store.getLeafId(),
    ]);
    expect(readFileSync(file, "utf-8")).not.toContain('{"type":"message"');
  });

  test("rejects malformed JSON before the final non-empty line and preserves the file", () => {
    const file = join(dir, "session.jsonl");
    const original = `${JSON.stringify(validHeader)}\n{"type":"custom"\n${JSON.stringify(makeEntry("root", null))}\n`;
    writeFileSync(file, original);

    expect(() => SessionStore.open(file)).toThrow(/line 2 is not valid JSON/i);
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  test("rejects duplicate entry ids", () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [validHeader, makeEntry("same", null), makeEntry("same", null)]);
    expect(() => SessionStore.open(file)).toThrow(/duplicate entry id same/i);
  });

  test("rejects missing parent references", () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [validHeader, makeEntry("child", "missing")]);
    expect(() => SessionStore.open(file)).toThrow(/references missing parent missing/i);
  });

  test("rejects self-parent and multi-entry parent cycles without hanging", () => {
    const selfFile = join(dir, "self.jsonl");
    writeJsonl(selfFile, [validHeader, makeEntry("self", "self")]);
    expect(() => SessionStore.open(selfFile)).toThrow(/own parent/i);

    const cycleFile = join(dir, "cycle.jsonl");
    writeJsonl(cycleFile, [validHeader, makeEntry("a", "b"), makeEntry("b", "a")]);
    expect(() => SessionStore.open(cycleFile)).toThrow(/parent cycle/i);
  });

  test("accepts leaf targets and parents declared earlier, but rejects missing leaf targets", () => {
    const validFile = join(dir, "valid-leaf.jsonl");
    writeJsonl(validFile, [
      validHeader,
      makeEntry("root", null),
      makeEntry("leaf-record", "root", { type: "leaf", targetId: "root" }),
    ]);
    expect(SessionStore.open(validFile).getLeafId()).toBe("root");

    const invalidFile = join(dir, "invalid-leaf.jsonl");
    writeJsonl(invalidFile, [
      validHeader,
      makeEntry("leaf-record", null, { type: "leaf", targetId: "missing" }),
    ]);
    expect(() => SessionStore.open(invalidFile)).toThrow(
      /leaf leaf-record references missing target/i,
    );
  });

  test("rejects compaction references missing from or outside the compaction branch", () => {
    const missingFile = join(dir, "missing-compaction.jsonl");
    writeJsonl(missingFile, [
      validHeader,
      makeEntry("root", null),
      makeEntry("compact", "root", {
        type: "compaction",
        summary: "summary",
        firstKeptEntryId: "missing",
        tokensBefore: 10,
      }),
    ]);
    expect(() => SessionStore.open(missingFile)).toThrow(/references missing first kept entry/i);

    const otherBranchFile = join(dir, "branch-compaction.jsonl");
    writeJsonl(otherBranchFile, [
      validHeader,
      makeEntry("root", null),
      makeEntry("kept", "root"),
      makeEntry("other", "root"),
      makeEntry("compact", "other", {
        type: "compaction",
        summary: "summary",
        firstKeptEntryId: "kept",
        tokensBefore: 10,
      }),
    ]);
    expect(() => SessionStore.open(otherBranchFile)).toThrow(/is not on its branch/i);
  });

  test("rejected open cannot append and leaves corrupted bytes unchanged", () => {
    const file = join(dir, "session.jsonl");
    writeJsonl(file, [validHeader, makeEntry("child", "missing")]);
    const original = readFileSync(file, "utf-8");
    let store: SessionStore | undefined;

    expect(() => {
      store = SessionStore.open(file);
    }).toThrow(/corrupted/i);
    expect(store).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe(original);
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
