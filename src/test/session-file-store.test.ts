import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionStore, sessionStorageDir } from "../sessions/session-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-session-file-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else files[child] = readFileSync(child, "utf-8");
    }
  };
  walk(root);
  return files;
}

describe("SessionStore", () => {
  test("inMemory keeps entries without creating a session file", async () => {
    const store = SessionStore.inMemory("/work");
    await store.appendMessage(user("ephemeral"));

    expect(store.getSessionFile()).toBeUndefined();
    expect(store.isPersisted()).toBe(false);
    expect(await store.getEntries()).toHaveLength(1);
    expect((await store.buildSessionContext()).messages).toHaveLength(1);
    await store.close();
  });

  test("create writes a private v5 header beside private durable storage", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work", { id: "session-1" });
    await store.appendMessage(user("persisted"));
    await store.close();

    const [header] = readFileSync(file, "utf-8").split("\n");
    expect(JSON.parse(header!)).toMatchObject({ v: 5, kind: "header", id: "session-1" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(sessionStorageDir(file)).mode & 0o777).toBe(0o700);
  });

  test("reopen preserves session id, lineage, entries, and cwd", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work", {
      id: "session-1",
      parentSession: "/parent.jsonl",
      parentSessionId: "parent-1",
    });
    await store.appendMessage(user("hello"));
    await store.appendCustomEntry("mikan.test", { cursor: 3 });
    await store.close();

    const reopened = await SessionStore.open(file);
    expect(reopened.getSessionId()).toBe("session-1");
    expect(reopened.getCwd()).toBe("/work");
    expect(reopened.getHeader()).toMatchObject({
      parentSession: "/parent.jsonl",
      parentSessionId: "parent-1",
    });
    const entries = await reopened.getEntries();
    expect(entries.map((entry) => entry.type)).toEqual(["message", "custom"]);
    expect(entries[1]).toMatchObject({ customType: "mikan.test", data: { cursor: 3 } });
    expect(entries[1]?.parentId).toBe(entries[0]?.id);
    expect(await reopened.getBranch(entries[0]!.id)).toEqual([entries[0]]);
    await reopened.close();
  });

  test("entry ids are unique across sessions", async () => {
    const first = await SessionStore.create(join(dir, "first.jsonl"), "/work");
    const second = await SessionStore.create(join(dir, "second.jsonl"), "/work");
    const firstId = await first.appendMessage(user("one"));
    const secondId = await second.appendMessage(user("two"));
    expect(firstId).not.toBe(secondId);
    await first.close();
    await second.close();
  });

  test("readHeader exposes lineage and source, and null for absent or unrecognized files", () => {
    const file = join(dir, "session.jsonl");
    SessionStore.writeHeaderFile(file, "/work", {
      id: "session-1",
      parentSessionId: "parent-1",
      source: { kind: "platform-history" },
    });
    expect(SessionStore.readHeader(file)).toMatchObject({
      type: "session",
      version: 5,
      id: "session-1",
      cwd: "/work",
      parentSessionId: "parent-1",
      metadata: { source: { kind: "platform-history" } },
    });
    expect(SessionStore.readHeader(join(dir, "missing.jsonl"))).toBeNull();
    const garbage = join(dir, "garbage.jsonl");
    writeFileSync(garbage, "not json\n");
    expect(SessionStore.readHeader(garbage)).toBeNull();
  });

  test("open of a v4 file asks for mikan migrate without rewriting it", async () => {
    const file = join(dir, "old.jsonl");
    const content = `${JSON.stringify({ v: 4, kind: "header", id: "old", storageVersion: 1, createdAt: 1, cwd: "/work" })}\n`;
    writeFileSync(file, content);
    await expect(SessionStore.open(file)).rejects.toThrow("mikan migrate");
    expect(readFileSync(file, "utf-8")).toBe(content);
    expect(existsSync(sessionStorageDir(file))).toBe(false);
  });

  test("open throws on content without a valid header instead of overwriting it", async () => {
    const file = join(dir, "broken.jsonl");
    writeFileSync(file, "garbage\n");
    await expect(SessionStore.open(file)).rejects.toThrow("not valid JSON");
    expect(readFileSync(file, "utf-8")).toBe("garbage\n");
  });

  test("a whitespace-only or missing file stays pending until the first append", async () => {
    const blank = join(dir, "blank.jsonl");
    writeFileSync(blank, "  \n");
    const missing = join(dir, "missing.jsonl");
    for (const file of [blank, missing]) {
      const store = await SessionStore.open(file, "/work");
      expect(existsSync(sessionStorageDir(file))).toBe(false);
      await store.appendMessage(user("first"));
      await store.close();
      expect(SessionStore.readHeader(file)?.cwd).toBe("/work");
      const reopened = await SessionStore.open(file);
      expect(await reopened.getEntries()).toHaveLength(1);
      await reopened.close();
    }
  });

  test("read-only inspection never changes its source", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    await store.appendMessage(user("kept"));
    await store.setSessionName("named");
    const before = snapshotTree(dir);
    const inspection = await SessionStore.inspect(file);
    expect(await inspection.getSessionName()).toBe("named");
    expect(JSON.stringify(await inspection.getEntries())).toContain("kept");
    expect(snapshotTree(dir)).toEqual(before);
    await store.close();
  });

  test("enforces one writer while allowing read-only inspection", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    await expect(SessionStore.open(file)).rejects.toThrow("active writer");
    await expect(SessionStore.inspect(file)).resolves.toBeDefined();
    await store.close();
    const reopened = await SessionStore.open(file);
    await reopened.close();
  });

  test("a leaked claim for a deleted file does not block an unrelated new file", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    rmSync(file);
    rmSync(sessionStorageDir(file), { recursive: true });
    const replacement = await SessionStore.create(file, "/work");
    await replacement.close();
    await store.close().catch(() => undefined);
  });

  test("hard-link aliases share one writer lease", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    const alias = join(dir, "alias.jsonl");
    linkSync(file, alias);
    await expect(SessionStore.open(alias)).rejects.toThrow("active writer");
    await store.close();
  });

  test("close is idempotent, drains unawaited mutations, and closed methods fail", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    void store.appendMessage(user("unawaited"));
    await Promise.all([store.close(), store.close()]);
    expect(() => store.getSessionId()).toThrow("closed");
    const reopened = await SessionStore.open(file);
    expect(JSON.stringify(await reopened.getEntries())).toContain("unawaited");
    await reopened.close();
  });

  test("session name comes from the latest set name", async () => {
    const store = SessionStore.inMemory("/work");
    await store.setSessionName("first");
    await store.setSessionName("  second  ");
    expect(await store.getSessionName()).toBe("second");
    await store.setSessionName("   ");
    expect(await store.getSessionName()).toBeUndefined();
    await store.close();
  });
});
