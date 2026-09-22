import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  branchTip,
  DEFAULT_COMPACTION_SETTINGS,
  getOrThrow,
  insertEntry,
  JsonlSessionRepo,
  setValue,
  TODO_CONTEXT,
  value,
  type AgentMessage,
  type NewEntry,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-session-file-store-"));
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
    expect(lines[0]).toMatchObject({ kind: "header", v: 4, storageVersion: 1, cwd: "/work" });
    expect(typeof lines[0]?.createdAt).toBe("number");
    const writes = lines.slice(1).flatMap((line) => (Array.isArray(line) ? line : [line]));
    const entry = writes.find((write) => write.kind === "entry");
    expect(entry).toMatchObject({ kind: "entry", type: "message", parentId: null });
    expect(typeof entry?.id).toBe("string");
  });

  test("readHeader folds only metadata writes and tolerates malformed JSONL", () => {
    const file = join(dir, "metadata.jsonl");
    SessionStore.writeHeaderFile(file, "/work");
    const header = readFileSync(file, "utf-8");
    const metadata = { kind: "value", namespace: "mikan", key: "metadata" };
    const lines = [
      JSON.stringify({ ...metadata, op: "set", value: { parentSessionPath: "/first" } }),
      "broken JSON",
      "",
      JSON.stringify([null, 1, { ...metadata, namespace: "other", op: "delete" }]),
      JSON.stringify([
        { ...metadata, op: "delete" },
        { ...metadata, op: "set", value: { parentSessionPath: "/last" } },
        { ...metadata, op: "set", value: [] },
        { ...metadata, op: "set", value: null },
      ]),
      "truncated",
    ];
    writeFileSync(file, header + lines.join("\n"));
    expect(SessionStore.readHeader(file)?.parentSession).toBe("/last");
    writeFileSync(
      file,
      header + lines.join("\n") + "\n" + JSON.stringify({ ...metadata, op: "delete" }),
    );
    expect(SessionStore.readHeader(file)?.metadata).toBeUndefined();
  });

  test("synchronous metadata inspection follows native Pi value writes and deletes", async () => {
    const repo = new JsonlSessionRepo({
      fileSystem: new NodeExecutionEnv({ cwd: dir }),
      sessionsRoot: dir,
    });
    const session = await repo.create({ cwd: dir }, TODO_CONTEXT);
    try {
      const address = value<{ parentSessionPath: string; source: { kind: string } }>(
        "mikan",
        "metadata",
      );
      const metadata = { parentSessionPath: "/parent.jsonl", source: { kind: "platform-history" } };
      await session.setValue(address, metadata, TODO_CONTEXT);
      expect(SessionStore.readHeader(session.metadata.path)).toMatchObject({
        parentSession: metadata.parentSessionPath,
        metadata,
      });
      const inspection = await SessionStore.inspect(session.metadata.path);
      expect(inspection.getHeader()).toEqual(SessionStore.readHeader(session.metadata.path));
      await session.deleteValue(address, TODO_CONTEXT);
      expect(SessionStore.readHeader(session.metadata.path)?.metadata).toBeUndefined();
    } finally {
      await session.close(TODO_CONTEXT);
      await repo.close(TODO_CONTEXT);
    }
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
    await seeded.close();

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

  test.each([false, true])(
    "inspection context matches Pi's native execution projection (compacted=%s)",
    async (compacted) => {
      const repo = new JsonlSessionRepo({
        fileSystem: new NodeExecutionEnv({ cwd: dir }),
        sessionsRoot: dir,
      });
      const native = await repo.create({ cwd: dir }, TODO_CONTEXT);
      const entries: NewEntry[] = [];
      type EntryPayload<T = NewEntry> = T extends NewEntry ? Omit<T, "id" | "parentId"> : never;
      const append = (entry: EntryPayload) => {
        const id = native.idGenerator.next();
        entries.push({ ...entry, id, parentId: entries.at(-1)?.id ?? null });
      };
      const kept: AgentMessage = { role: "user", content: "recent", timestamp: 2 };
      const excluded = ["error", "aborted", "deferred"] as const;
      const failed = excluded.map((stopReason) =>
        Object.assign(fauxAssistantMessage(`excluded ${stopReason}`), { stopReason }),
      );
      append({ type: "message", message: { role: "user", content: "old", timestamp: 1 } });
      if (compacted) {
        append({
          type: "compaction",
          summary: "obsolete summary",
          retainedTail: [],
          tokensBefore: 10,
          fromHook: false,
        });
        append({
          type: "compaction",
          summary: "current summary",
          retainedTail: [kept, ...failed],
          tokensBefore: 20,
          fromHook: false,
        });
      } else {
        append({ type: "message", message: kept });
      }
      for (const message of failed) append({ type: "message", message });
      append({ type: "custom", customType: "mikan.chat_sync", data: { lastMessageId: "123" } });
      append({
        type: "branch_summary",
        fromId: entries[0]!.id,
        summary: "branch summary",
        fromHook: false,
      });
      append({ type: "message", message: fauxAssistantMessage("settled answer") });
      await native.mutate(async (mutation, context) => {
        await mutation.commit(
          [
            ...entries.map((entry) => insertEntry(entry)),
            setValue(branchTip("main"), entries.at(-1)!.id),
          ],
          context,
        );
      }, TODO_CONTEXT);
      const file = native.metadata.path;
      await native.close(TODO_CONTEXT);
      await repo.close(TODO_CONTEXT);

      const store = await SessionStore.open(file);
      try {
        const projected = (await store.buildSessionContext()).messages;
        const inspection = await SessionStore.inspect(file);
        expect((await inspection.buildSessionContext()).messages).toEqual(projected);
        const rendered = JSON.stringify(projected);
        expect(rendered).toContain("recent");
        expect(rendered).toContain("branch summary");
        expect(rendered).not.toContain("excluded");
        if (compacted) {
          expect(rendered).toContain("current summary");
          expect(rendered).not.toContain("obsolete summary");
          expect(rendered).not.toContain('"old"');
        }

        const models = createModels();
        const faux = fauxProvider();
        models.setProvider(faux.provider);
        faux.setResponses([fauxAssistantMessage("next answer")]);
        const harness = await store.createHarness({
          models,
          model: faux.getModel(),
          compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
        });
        let nativeContext: AgentMessage[] | undefined;
        harness.hooks.on("transform_context", ({ messages }) => {
          nativeContext = structuredClone(messages);
          return undefined;
        });
        const next: AgentMessage = { role: "user", content: "continue", timestamp: 3 };
        const lane = await harness.lane("main", TODO_CONTEXT);
        getOrThrow(await lane.prompt(next, TODO_CONTEXT));
        expect(nativeContext?.filter((message) => message.role !== "system")).toEqual([
          ...projected,
          next,
        ]);
      } finally {
        await store.close();
      }
    },
  );

  test("open throws on a file with content but no valid header, instead of silently overwriting", async () => {
    const notJson = join(dir, "not-json.jsonl");
    writeFileSync(notJson, 'not json\n{"kind":"entry","content":"kept"}\n');
    await expect(SessionStore.open(notJson, "/work")).rejects.toThrow(/not valid JSON/i);
    expect(readFileSync(notJson, "utf-8")).toContain("kept");

    const wrongShape = join(dir, "wrong-shape.jsonl");
    writeFileSync(wrongShape, '{"hello":"world"}\n');
    await expect(SessionStore.open(wrongShape, "/work")).rejects.toThrow(/unrecognized header/i);
  });

  test.each([null, [], "header", 4])("open rejects a non-object header: %j", async (header) => {
    const file = join(dir, "invalid-header.jsonl");
    const original = `${JSON.stringify(header)}\n`;
    writeFileSync(file, original);
    await expect(SessionStore.open(file)).rejects.toThrow(/unrecognized header/i);
    expect(SessionStore.readHeader(file)).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("open treats a whitespace-only file as empty and materializes on append", async () => {
    const file = join(dir, "blank.jsonl");
    writeFileSync(file, "\n  \n");
    const store = await SessionStore.open(file, "/work");
    expect(readFileSync(file, "utf-8").trim()).toBe("");
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    });
    expect(readLines(file)[0]).toMatchObject({ kind: "header", v: 4, storageVersion: 1 });
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
    expect(lines[0]).toMatchObject({
      kind: "header",
      v: 4,
      storageVersion: 1,
      id: sessionId,
      cwd: "/work",
    });
    expect(lines.slice(1).flatMap((line) => (Array.isArray(line) ? line : [line]))).toContainEqual(
      expect.objectContaining({ kind: "entry", type: "message" }),
    );
  });

  test("empty pending materialization truncates the original file", async () => {
    const file = join(dir, "empty-with-padding.jsonl");
    writeFileSync(file, `${" ".repeat(8192)}\n`);
    const store = await SessionStore.open(file, "/work");
    await store.appendMessage({ role: "user", content: "clean", timestamp: 1 });
    await store.close();

    expect(readFileSync(file, "utf8")).not.toContain(" ".repeat(128));
    expect(
      readLines(file)
        .slice(1)
        .flatMap((line) => (Array.isArray(line) ? line : [line]))
        .filter((line) => line.kind === "entry"),
    ).toHaveLength(1);
  });

  test("read-only inspection never repairs or changes its source file", async () => {
    const file = join(dir, "torn-inspection.jsonl");
    const writer = await SessionStore.create(file, "/work");
    await writer.appendMessage({ role: "user", content: "kept", timestamp: 1 });
    await writer.close();
    writeFileSync(file, '{"kind":"entry"', { flag: "a" });
    const before = readFileSync(file);

    await SessionStore.inspect(file).catch(() => undefined);

    expect(readFileSync(file)).toEqual(before);
  });

  test("enforces one writer while allowing read-only inspection", async () => {
    const file = join(dir, "owned.jsonl");
    const writer = await SessionStore.create(file, "/work");
    await expect(SessionStore.open(file)).rejects.toThrow(/active writer/i);

    const inspection = await SessionStore.inspect(file);
    expect(inspection.getHeader().id).toBe(writer.getSessionId());
    await writer.close();
    await expect(SessionStore.open(file)).resolves.toBeDefined();
  });

  test("a leaked claim for a deleted file does not block an unrelated new file", async () => {
    const leakedDir = join(dir, "leaked-office");
    mkdirSync(leakedDir, { recursive: true });
    await SessionStore.create(join(leakedDir, "session.jsonl"), "/work");
    rmSync(leakedDir, { recursive: true, force: true });

    const fresh = await SessionStore.create(join(dir, "fresh.jsonl"), "/work");
    await fresh.close();
  });

  test("hard-link aliases share one writer lease", async () => {
    const file = join(dir, "owned.jsonl");
    const alias = join(dir, "owned-alias.jsonl");
    const writer = await SessionStore.create(file, "/work");
    linkSync(file, alias);

    await expect(SessionStore.open(alias)).rejects.toThrow(/active writer/i);
    await writer.close();
    const reopened = await SessionStore.open(alias);
    await reopened.close();
  });

  test("pending writer promotes its lease to the materialized inode", async () => {
    const file = join(dir, "pending-owned.jsonl");
    const alias = join(dir, "pending-owned-alias.jsonl");
    const writer = await SessionStore.open(file, "/work");
    await writer.appendMessage({ role: "user", content: "materialized", timestamp: 1 });
    linkSync(file, alias);

    await expect(SessionStore.open(alias)).rejects.toThrow(/active writer/i);
    await writer.close();
  });

  test("pending materialization refuses external changes", async () => {
    const file = join(dir, "pending.jsonl");
    const store = await SessionStore.open(file, "/work");
    writeFileSync(file, "external\n");

    await expect(
      store.appendMessage({ role: "user", content: "hi", timestamp: 1 }),
    ).rejects.toThrow();
    expect(readFileSync(file, "utf-8")).toBe("external\n");
    await store.close();
  });

  test("close is idempotent and closed methods fail", async () => {
    const file = join(dir, "close.jsonl");
    const store = await SessionStore.create(file, "/work");
    await Promise.all([store.close(), store.close()]);
    expect(() => store.getSessionId()).toThrow(/closed/i);
    await expect(
      store.appendMessage({ role: "user", content: "late", timestamp: 1 }),
    ).rejects.toThrow(/closed/i);
    const reopened = await SessionStore.open(file);
    await reopened.close();
  });

  test("close drains mutations that callers did not await", async () => {
    const file = join(dir, "drain.jsonl");
    const store = await SessionStore.create(file, "/work");
    void store.appendMessage({ role: "user", content: "drained", timestamp: 1 });
    await store.close();

    const inspection = await SessionStore.inspect(file);
    expect(await inspection.getEntries()).toHaveLength(1);
  });

  test("session name comes from the latest set name", async () => {
    const file = join(dir, "session.jsonl");
    const store = await SessionStore.create(file, "/work");
    expect(await store.getSessionName()).toBeUndefined();
    await store.setSessionName("first name");
    await store.setSessionName("second name");
    expect(await store.getSessionName()).toBe("second name");
    await store.close();

    const reopened = await SessionStore.open(file);
    expect(await reopened.getSessionName()).toBe("second name");
    await reopened.close();
  });
});
