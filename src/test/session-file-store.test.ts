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
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
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

function answer(text: string, totalTokens: number, stopReason: "stop" | "error" = "stop") {
  const message = fauxAssistantMessage(text, { stopReason });
  message.usage.totalTokens = totalTokens;
  return message;
}

describe("SessionStore", () => {
  test("context tokens come from the newest successful answer after compaction", async () => {
    const store = SessionStore.inMemory();
    await store.appendMessage(user("old"));
    await store.appendMessage(answer("old answer", 900));
    expect(await store.getContextTokens()).toBe(900);

    await store.appendCompactionSummary("summary", 2);
    expect(await store.getContextTokens()).toBeUndefined();

    await store.appendMessage(user("new"));
    await store.appendMessage(answer("new answer", 120));
    await store.appendMessage(answer("", 999, "error"));
    expect(await store.getContextTokens()).toBe(120);
    await store.close();
  });

  test("inMemory keeps entries without creating a session file", async () => {
    const store = SessionStore.inMemory();
    await store.appendMessage(user("ephemeral"));

    expect(await store.getEntries()).toHaveLength(1);
    expect((await store.buildSessionContext()).messages).toHaveLength(1);
    await store.close();
  });

  test("create writes a private header beside private durable storage", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, { id: "session-1" });
    await store.appendMessage(user("persisted"));
    await store.close();

    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      id: "session-1",
      createdAt: expect.any(Number),
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(sessionStorageDir(file)).mode & 0o777).toBe(0o700);
  });

  test("reopen preserves session id, lineage, entries, and cwd", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, {
      id: "session-1",
      parentSessionId: "parent-1",
    });
    await store.appendMessage(user("hello"));
    await store.appendCustomEntry("mikan.test", { cursor: 3 });
    await store.close();

    const reopened = await SessionStore.open(file);
    expect(reopened.getSessionId()).toBe("session-1");
    expect(reopened.getHeader()).toMatchObject({ parentSessionId: "parent-1" });
    const entries = await reopened.getEntries();
    expect(entries.map((entry) => entry.type)).toEqual(["message", "custom"]);
    expect(entries[1]).toMatchObject({ customType: "mikan.test", data: { cursor: 3 } });
    await reopened.close();
  });

  test("entry ids are unique across sessions", async () => {
    const first = await SessionStore.create(join(dir, "first.jsonl"));
    const second = await SessionStore.create(join(dir, "second.jsonl"));
    const firstId = await first.appendMessage(user("one"));
    const secondId = await second.appendMessage(user("two"));
    expect(firstId).not.toBe(secondId);
    await first.close();
    await second.close();
  });

  test("readHeader exposes lineage, and null for absent or unrecognized files", () => {
    const file = join(dir, "session.jsonl");
    SessionStore.writeHeaderFile(file, {
      id: "session-1",
      parentSessionId: "parent-1",
    });
    expect(SessionStore.readHeader(file)).toEqual({
      id: "session-1",
      createdAt: expect.any(Number),
      parentSessionId: "parent-1",
    });
    expect(SessionStore.readHeader(join(dir, "missing.jsonl"))).toBeNull();
    const garbage = join(dir, "garbage.jsonl");
    writeFileSync(garbage, "not json\n");
    expect(SessionStore.readHeader(garbage)).toBeNull();
  });

  test("open throws on content without a valid header instead of overwriting it", async () => {
    const file = join(dir, "broken.jsonl");
    writeFileSync(file, "garbage\n");
    await expect(SessionStore.open(file)).rejects.toThrow("not valid JSON");
    expect(readFileSync(file, "utf-8")).toBe("garbage\n");
  });

  test("a missing file stays pending until the first append", async () => {
    const file = join(dir, "missing.jsonl");
    const store = await SessionStore.open(file);
    expect(existsSync(sessionStorageDir(file))).toBe(false);
    await store.appendMessage(user("first"));
    await store.close();
    expect(SessionStore.readHeader(file)).not.toBeNull();
    const reopened = await SessionStore.open(file);
    expect(await reopened.getEntries()).toHaveLength(1);
    await reopened.close();
  });

  test("read-only inspection never changes its source", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file);
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
    const store = await SessionStore.create(file);
    await expect(SessionStore.open(file)).rejects.toThrow("active writer");
    await expect(SessionStore.inspect(file)).resolves.toBeDefined();
    await store.close();
    const reopened = await SessionStore.open(file);
    await reopened.close();
  });

  test("a leaked claim for a deleted file does not block an unrelated new file", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file);
    rmSync(file);
    rmSync(sessionStorageDir(file), { recursive: true });
    const replacement = await SessionStore.create(file);
    await replacement.close();
    await store.close().catch(() => undefined);
  });

  test("hard-link aliases share one writer lease", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file);
    const alias = join(dir, "alias.jsonl");
    linkSync(file, alias);
    await expect(SessionStore.open(alias)).rejects.toThrow("active writer");
    await store.close();
  });

  test("close is idempotent, drains unawaited mutations, and closed methods fail", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file);
    void store.appendMessage(user("unawaited"));
    await Promise.all([store.close(), store.close()]);
    expect(() => store.getSessionId()).toThrow("closed");
    const reopened = await SessionStore.open(file);
    expect(JSON.stringify(await reopened.getEntries())).toContain("unawaited");
    await reopened.close();
  });

  test("session name comes from the latest set name", async () => {
    const store = SessionStore.inMemory();
    await store.setSessionName("first");
    await store.setSessionName("  second  ");
    expect(await store.getSessionName()).toBe("second");
    await store.setSessionName("   ");
    expect(await store.getSessionName()).toBeUndefined();
    await store.close();
  });
});
