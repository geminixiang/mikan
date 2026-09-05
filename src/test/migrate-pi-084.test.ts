import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../harness/session-store.js";
import {
  findPi084SessionFiles,
  isPi084SessionFile,
  migratePi084SessionFile,
} from "../sessions/migrate-pi-084.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-migrate-pi-084-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeOldSession(file: string): void {
  const records = [
    {
      kind: "header",
      version: 4,
      id: "old-session",
      createdAt: 1000,
      cwd: "/work",
      parentSessionId: "parent-id",
      metadata: {
        parentSessionPath: "/old/parent.jsonl",
        source: { kind: "platform-history", file: "log.jsonl" },
      },
    },
    {
      kind: "entry",
      lane: "main",
      type: "message",
      id: "a",
      seq: 1,
      parentId: null,
      timestamp: 1100,
      message: { role: "user", content: "hello", timestamp: 1100 },
    },
    {
      kind: "entry",
      lane: "main",
      type: "thinking_level_change",
      id: "b",
      seq: 2,
      parentId: "a",
      timestamp: 1200,
      thinkingLevel: "high",
    },
    {
      kind: "entry",
      lane: "main",
      type: "compaction",
      id: "c",
      seq: 3,
      parentId: "b",
      timestamp: 1300,
      summary: "summary",
      retainedTail: [{ role: "user", content: "tail", timestamp: 1250 }],
      tokensBefore: 42,
      details: { reason: "threshold" },
    },
    { kind: "lane", seq: 4, lane: "main", leafId: "c" },
    { kind: "fact", seq: 5, fact: "name", name: "Migrated" },
    { kind: "fact", seq: 6, fact: "label", targetId: "a", label: "start" },
    {
      kind: "record",
      type: "operation_finished",
      id: "run-1",
      runId: "run-1",
      lane: "main",
      seq: 7,
      timestamp: 1400,
      outcome: "completed",
    },
  ];
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function readLines(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("Pi 0.84 session migration", () => {
  test("converts the old v4 schema and preserves tree, tip, metadata, and facts", async () => {
    const file = join(dir, "session.jsonl");
    writeOldSession(file);

    expect(isPi084SessionFile(file)).toBe(true);
    await expect(SessionStore.open(file)).rejects.toThrow(/Pi 0\.84/);

    expect(await migratePi084SessionFile(file)).toEqual({ file, status: "migrated" });
    expect(existsSync(`${file}.pi-084.bak`)).toBe(true);

    const lines = readLines(file) as Array<Record<string, unknown>>;
    expect(lines[0]).toMatchObject({ v: 4, kind: "header", storageVersion: 1, id: "old-session" });
    expect(lines.some((line) => line.kind === "lane" || line.kind === "fact")).toBe(false);
    expect(
      lines.some(
        (line) => line.kind === "value" && line.namespace === "pi.entry.label" && line.key === "a",
      ),
    ).toBe(true);
    expect(
      lines.some((line) => line.kind === "list" && line.namespace === "mikan.pi084.records"),
    ).toBe(true);

    const inspection = await SessionStore.inspect(file);
    const entries = await inspection.getEntries();
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(entries[1]).toMatchObject({
      type: "custom",
      customType: "mikan.pi084.thinking_level_change",
    });
    expect(entries[2]).toMatchObject({ type: "compaction", fromHook: false, tokensBefore: 42 });
    expect((await inspection.getBranch()).at(-1)?.id).toBe("c");
    expect(await inspection.getSessionName()).toBe("Migrated");
    expect(inspection.getHeader()).toMatchObject({
      id: "old-session",
      parentSessionId: "parent-id",
      parentSession: "/old/parent.jsonl",
      metadata: { source: { kind: "platform-history" } },
    });
  });

  test("dry run and discovery leave the source untouched", async () => {
    const file = join(dir, "nested", "session.jsonl");
    mkdirSync(join(dir, "nested"));
    writeOldSession(file);
    const before = readFileSync(file);

    expect(findPi084SessionFiles(dir)).toEqual([file]);
    expect(await migratePi084SessionFile(file, { dryRun: true })).toMatchObject({
      status: "migrated",
      detail: "dry run",
    });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(`${file}.pi-084.bak`)).toBe(false);
  });

  test("refuses to overwrite an existing backup", async () => {
    const file = join(dir, "session.jsonl");
    writeOldSession(file);
    writeFileSync(`${file}.pi-084.bak`, "existing backup");

    await expect(migratePi084SessionFile(file)).rejects.toThrow(/Backup already exists/);
    expect(isPi084SessionFile(file)).toBe(true);
    expect(readFileSync(`${file}.pi-084.bak`, "utf8")).toBe("existing backup");
  });

  test("resumes when a prior attempt created only the hard-link backup", async () => {
    const file = join(dir, "session.jsonl");
    writeOldSession(file);
    linkSync(file, `${file}.pi-084.bak`);

    expect(await migratePi084SessionFile(file)).toEqual({ file, status: "migrated" });
    expect(isPi084SessionFile(`${file}.pi-084.bak`)).toBe(true);
  });

  test("discovery does not follow directory symlinks", () => {
    const outside = join(dir, "outside");
    const root = join(dir, "root");
    mkdirSync(outside);
    mkdirSync(root);
    const outsideFile = join(outside, "session.jsonl");
    writeOldSession(outsideFile);
    symlinkSync(outside, join(root, "linked"));

    expect(findPi084SessionFiles(root)).toEqual([]);
  });

  test("reports current files as already migrated", async () => {
    const file = join(dir, "current.jsonl");
    const store = await SessionStore.create(file, "/work");
    await store.appendMessage({ role: "user", content: "current", timestamp: 1 });
    await store.close();

    expect(await migratePi084SessionFile(file)).toEqual({ file, status: "already-current" });
  });
});
