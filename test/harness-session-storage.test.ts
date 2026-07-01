import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MikanSessionStorage } from "../src/harness/session-storage.js";

let dir: string;

beforeEach(() => {
  dir = join(
    tmpdir(),
    `harness-session-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sessionFile(): string {
  return join(dir, "session.jsonl");
}

async function appendMessage(
  storage: MikanSessionStorage,
  role: "user" | "assistant",
  text: string,
): Promise<string> {
  const id = await storage.createEntryId();
  const parentId = await storage.getLeafId();
  const entry: SessionTreeEntry = {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    } as never,
  };
  await storage.appendEntry(entry);
  return id;
}

describe("MikanSessionStorage", () => {
  test("create() writes a version:3 header immediately", async () => {
    const file = sessionFile();
    MikanSessionStorage.create(file, "/workspace");

    const raw = readFileSync(file, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header).toMatchObject({ type: "session", version: 3, cwd: "/workspace" });
    expect(typeof header.id).toBe("string");
  });

  test("appendEntry persists each entry as a JSON line and advances the leaf", async () => {
    const file = sessionFile();
    const storage = MikanSessionStorage.create(file, "/workspace");

    const userId = await appendMessage(storage, "user", "hello");
    expect(await storage.getLeafId()).toBe(userId);

    const assistantId = await appendMessage(storage, "assistant", "hi there");
    expect(await storage.getLeafId()).toBe(assistantId);

    const entries = await storage.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe(userId);
    expect(entries[0].parentId).toBeNull();
    expect(entries[1].parentId).toBe(userId);

    // Re-read the raw file: header + 2 entries, one JSON object per line.
    const lines = readFileSync(file, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  test("re-opening an existing file reproduces identical bytes and state", async () => {
    const file = sessionFile();
    const first = MikanSessionStorage.create(file, "/workspace");
    await appendMessage(first, "user", "hello");
    await appendMessage(first, "assistant", "hi there");
    const before = readFileSync(file, "utf-8");

    const reopened = MikanSessionStorage.open(file, "/workspace");
    expect(await reopened.getEntries()).toHaveLength(2);
    expect(await reopened.getLeafId()).toBe((await first.getEntries()).at(-1)!.id);

    // Reopening must not rewrite the file.
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  test("getPathToRoot walks the parentId chain from leaf to root", async () => {
    const file = sessionFile();
    const storage = MikanSessionStorage.create(file, "/workspace");
    const first = await appendMessage(storage, "user", "one");
    const second = await appendMessage(storage, "assistant", "two");
    const third = await appendMessage(storage, "user", "three");

    const path = await storage.getPathToRoot(third);
    expect(path.map((e) => e.id)).toEqual([first, second, third]);
    expect(await storage.getPathToRoot(null)).toEqual([]);
  });

  test("getPathToRoot throws SessionError for an unknown leaf id", async () => {
    const file = sessionFile();
    const storage = MikanSessionStorage.create(file, "/workspace");
    await expect(storage.getPathToRoot("missing")).rejects.toThrow(/not found/);
  });

  test("label entries are tracked and cleared via getLabel", async () => {
    const file = sessionFile();
    const storage = MikanSessionStorage.create(file, "/workspace");
    const messageId = await appendMessage(storage, "user", "hello");

    await storage.appendEntry({
      type: "label",
      id: await storage.createEntryId(),
      parentId: await storage.getLeafId(),
      timestamp: new Date().toISOString(),
      targetId: messageId,
      label: "important",
    });
    expect(await storage.getLabel(messageId)).toBe("important");

    await storage.appendEntry({
      type: "label",
      id: await storage.createEntryId(),
      parentId: await storage.getLeafId(),
      timestamp: new Date().toISOString(),
      targetId: messageId,
      label: undefined,
    });
    expect(await storage.getLabel(messageId)).toBeUndefined();
  });

  test("findEntries filters by entry type", async () => {
    const file = sessionFile();
    const storage = MikanSessionStorage.create(file, "/workspace");
    await appendMessage(storage, "user", "hello");
    await storage.appendEntry({
      type: "model_change",
      id: await storage.createEntryId(),
      parentId: await storage.getLeafId(),
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      modelId: "claude-3-5-haiku-latest",
    });

    expect(await storage.findEntries("message")).toHaveLength(1);
    expect(await storage.findEntries("model_change")).toHaveLength(1);
    expect(await storage.findEntries("compaction")).toHaveLength(0);
  });

  test("getRawHeader() exposes source.kind for platform-history detection", async () => {
    const file = sessionFile();
    const header = {
      type: "session",
      version: 3,
      id: "abc12345",
      timestamp: new Date().toISOString(),
      cwd: "/workspace",
      source: { kind: "platform-history" },
    };
    writeFileSync(file, `${JSON.stringify(header)}\n`);

    const storage = MikanSessionStorage.open(file, "/workspace");
    expect(storage.getRawHeader().source?.kind).toBe("platform-history");
  });

  test("a corrupted trailing entry line is skipped with a warning, not fatal", async () => {
    const file = sessionFile();
    const header = {
      type: "session",
      version: 3,
      id: "abc12345",
      timestamp: new Date().toISOString(),
      cwd: "/workspace",
    };
    const goodEntry = {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    };
    writeFileSync(
      file,
      `${JSON.stringify(header)}\n${JSON.stringify(goodEntry)}\nnot valid json\n`,
    );

    const storage = MikanSessionStorage.open(file, "/workspace");
    const entries = await storage.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("e1");
  });

  test("a missing/corrupted header falls back to starting a fresh session", async () => {
    const file = sessionFile();
    writeFileSync(file, "not a header at all\n");

    const storage = MikanSessionStorage.open(file, "/workspace");
    expect(await storage.getEntries()).toEqual([]);
    expect(await storage.getLeafId()).toBeNull();

    const header = JSON.parse(readFileSync(file, "utf-8").trim().split("\n")[0]);
    expect(header.type).toBe("session");
    expect(header.version).toBe(3);
  });

  test("entry ids from independently-created sessions never collide, even created in the same instant", async () => {
    // Regression test: entry ids must not be derived from a truncated
    // time-ordered id (e.g. uuidv7's leading bytes), since two unrelated
    // session files created within the same millisecond would then get
    // colliding first-entry ids, corrupting cross-session id matching
    // (e.g. session-view's thread-anchor detection).
    const storageA = MikanSessionStorage.create(join(dir, "a.jsonl"), "/workspace");
    const storageB = MikanSessionStorage.create(join(dir, "b.jsonl"), "/workspace");

    const idA = await appendMessage(storageA, "user", "hello from a");
    const idB = await appendMessage(storageB, "user", "hello from b");

    expect(idA).not.toBe(idB);
  });
});
