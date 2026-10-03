import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runHistory } from "../harness/tools/history.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getThreadSessionFile,
} from "../sessions/store.js";

let dir: string;
let clock = 0;
let office: Office;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-history-"));
  office = createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") }).office(
    createOfficeAddress("slack", "C1"),
  );
  office.ensure();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function sessionWith(file: string, texts: string[]): Promise<string> {
  const store = await SessionStore.open(file);
  for (const text of texts) {
    await store.appendMessage({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: ++clock,
    });
  }
  await store.close();
  return file;
}

function idOf(file: string): string {
  return SessionStore.readHeader(file)?.id ?? "";
}

describe("history tool", () => {
  test("lists the conversation's sessions, marking current and this one", async () => {
    const earlier = await sessionWith(createManagedSessionFile(office.sessionsDir), ["old work"]);
    const main = await sessionWith(createManagedSessionFile(office.sessionsDir), ["new work"]);
    const thread = createManagedSessionFileAtPath(
      getThreadSessionFile(office.sessionsDir, "C1:1000.1"),
      idOf(main),
    );
    writeFileSync(
      office.logPath,
      `${JSON.stringify({ ts: "1000.1", userName: "alice", text: "Deploy plan\nmore" })}\n`,
    );

    const text = await runHistory({ office, sessionFile: thread }, { action: "sessions" });

    expect(text).toContain("3 sessions");
    expect(text).toContain(`${idOf(earlier)} (main,`);
    expect(text).toContain(`${idOf(main)} (main, current,`);
    expect(text).toContain(`* ${idOf(thread)} (thread,`);
    expect(text).toContain(`parent=${idOf(main).slice(0, 8)}) [alice]: Deploy plan`);
  });

  test("lists every session by default, beyond the search page size", async () => {
    for (let index = 0; index < 25; index++) createManagedSessionFile(office.sessionsDir);
    const sessions = await runHistory(
      { office, sessionFile: createManagedSessionFile(office.sessionsDir) },
      { action: "sessions" },
    );

    expect(sessions.split("\n\n")).toHaveLength(27);
  });

  test("searches every session, newest last, and narrows to one by id prefix", async () => {
    const earlier = await sessionWith(createManagedSessionFile(office.sessionsDir), ["deploy v1"]);
    const main = await sessionWith(createManagedSessionFile(office.sessionsDir), [
      "deploy v2",
      "lunch",
    ]);
    const scope = { office, sessionFile: main };

    const all = await runHistory(scope, { action: "search", query: "DEPLOY" });
    expect(all).toContain("2 matching entries in 2 sessions");
    expect(all.indexOf("deploy v1")).toBeLessThan(all.indexOf("deploy v2"));
    expect(all).not.toContain("lunch");

    const one = await runHistory(scope, {
      action: "search",
      query: "deploy",
      session: idOf(earlier).slice(0, 8),
    });
    expect(one).toContain("deploy v1");
    expect(one).not.toContain("deploy v2");

    expect(await runHistory(scope, { action: "search", query: "deploy", session: "abc" })).toBe(
      "Use at least 8 characters of a session id.",
    );
  });

  test("reads the current session by default, paging back with skip", async () => {
    const main = await sessionWith(createManagedSessionFile(office.sessionsDir), [
      "one",
      "two",
      "three",
    ]);
    const scope = { office, sessionFile: main };

    const newest = await runHistory(scope, { action: "read", limit: 2 });
    expect(newest).toContain("3 entries; 2 newest shown");
    expect(newest.indexOf("[user] two")).toBeLessThan(newest.indexOf("[user] three"));
    expect(newest).not.toContain("[user] one");

    expect(await runHistory(scope, { action: "read", limit: 2, skip: 2 })).toContain("[user] one");
  });

  test("searches the chat log, including messages no session holds", async () => {
    const main = createManagedSessionFile(office.sessionsDir);
    writeFileSync(
      office.logPath,
      [
        { ts: "1.1", date: "2026-05-01T00:00:00Z", userName: "bob", text: "staging is down" },
        { ts: "1.2", date: "2026-05-01T00:01:00Z", userName: "carol", text: "lunch?" },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );

    const text = await runHistory(
      { office, sessionFile: main },
      { action: "chat", query: "staging" },
    );

    expect(text).toContain("1 matching chat messages");
    expect(text).toContain("[bob]: staging is down");
    expect(text).not.toContain("lunch");
  });

  test("matches every word of a query, wherever it appears", async () => {
    const main = await sessionWith(createManagedSessionFile(office.sessionsDir), [
      "ran date +%s%N | sha1sum | cut -c1-10",
      "ran sha1sum alone",
    ]);

    const text = await runHistory(
      { office, sessionFile: main },
      { action: "search", query: "date +%s%N sha1sum" },
    );

    expect(text).toContain("1 matching entries");
    expect(text).toContain("cut -c1-10");
  });

  test("matches a Chinese query by most of its character pairs, not only verbatim", async () => {
    const main = await sessionWith(createManagedSessionFile(office.sessionsDir), [
      "這是暫時註記：代號 NEW_X1",
      "完全無關的內容",
    ]);
    const scope = { office, sessionFile: main };

    const text = await runHistory(scope, { action: "search", query: "暫時代號" });

    expect(text).toContain("NEW_X1");
    expect(text).not.toContain("完全無關");
    expect(await runHistory(scope, { action: "search", query: "代號 無關" })).toBe(
      'No session entries match "代號 無關".',
    );
  });

  test("does not echo its own earlier results back into a search", async () => {
    const main = createManagedSessionFile(office.sessionsDir);
    const store = await SessionStore.open(main);
    await store.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "h1",
          name: "history",
          arguments: { action: "search", query: "x" },
        },
      ],
      api: "faux",
      provider: "faux",
      model: "faux",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: ++clock,
    });
    await store.appendMessage({
      role: "toolResult",
      content: [{ type: "text", text: "earlier found deploy v9" }],
      toolCallId: "h1",
      toolName: "history",
      isError: false,
      timestamp: ++clock,
    });
    await store.close();

    expect(
      await runHistory({ office, sessionFile: main }, { action: "search", query: "search x" }),
    ).toBe('No session entries match "search x".');
    expect(await runHistory({ office, sessionFile: main }, { action: "search", query: "v9" })).toBe(
      'No session entries match "v9".',
    );
  });

  test("keeps the newest results when the output limit cuts older ones", async () => {
    const main = await sessionWith(
      createManagedSessionFile(office.sessionsDir),
      Array.from({ length: 20 }, (_, index) => `entry ${index} ${"y".repeat(1990)}`),
    );

    const text = await runHistory({ office, sessionFile: main }, { action: "read", limit: 20 });

    expect(text).toContain("entry 19 ");
    expect(text).not.toContain("entry 0 ");
    expect(text).toMatch(/older results omitted by the output limit; use skip=\d+/);
    expect(text.length).toBeLessThan(31_000);
  });
});
