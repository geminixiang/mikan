import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
let office: Office;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-session-store-"));
  office = createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") }).office(
    createOfficeAddress("slack", "C1"),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function user(text: string, timestamp = 1): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function answer(text: string, totalTokens: number, stopReason: "stop" | "error" = "stop") {
  const message = fauxAssistantMessage(text, { stopReason });
  message.usage.totalTokens = totalTokens;
  return message;
}

async function contextText(key: string): Promise<string> {
  const inspection = await SessionStore.inspect(office, key);
  return JSON.stringify((await inspection?.buildSessionContext())?.messages ?? []);
}

describe("SessionStore", () => {
  test("one private storage file holds the office's sessions", async () => {
    const channel = await SessionStore.open(office, "C1");
    const thread = await SessionStore.open(office, "C1:1000.1");
    await channel.appendMessage(user("in channel"));
    await thread.appendMessage(user("in thread"));
    await channel.close();
    await thread.close();

    expect(statSync(office.sessionsPath).mode & 0o777).toBe(0o600);
    expect(await contextText("C1")).toContain("in channel");
    expect(await contextText("C1")).not.toContain("in thread");
    expect(await contextText("C1:1000.1")).toContain("in thread");
  });

  test("a session keeps its id and entries across reopen; sessions get distinct ids", async () => {
    const channel = await SessionStore.open(office, "C1");
    await channel.appendMessage(user("hello"));
    await channel.appendCustomEntry("mikan.test", { cursor: 3 });
    const channelId = channel.getSessionId();
    await channel.close();
    const thread = await SessionStore.open(office, "C1:1000.1");
    const threadId = thread.getSessionId();
    await thread.close();

    const reopened = await SessionStore.open(office, "C1");
    expect(reopened.getSessionId()).toBe(channelId);
    expect(threadId).not.toBe(channelId);
    const entries = await reopened.getEntries();
    expect(entries.map((entry) => entry.type)).toEqual(["message", "custom"]);
    expect(entries[1]).toMatchObject({ customType: "mikan.test", data: { cursor: 3 } });
    expect(entries[0]?.id.startsWith(`${channelId}:`)).toBe(true);
    await reopened.close();
  });

  test("lists sessions with the top-level session as root", async () => {
    for (const key of ["C1", "C1:1000.1"]) await (await SessionStore.open(office, key)).close();

    const listing = await SessionStore.list(office);

    expect(listing.map((session) => [session.key, session.root]).toSorted()).toEqual([
      ["C1", true],
      ["C1:1000.1", false],
    ]);
    expect(await SessionStore.exists(office, "C1:1000.1")).toBe(true);
    expect(await SessionStore.exists(office, "C1:2000.1")).toBe(false);
  });

  test("reset starts a new context and keeps earlier entries readable", async () => {
    const channel = await SessionStore.open(office, "C1");
    await channel.appendMessage(user("before reset"));
    await channel.reset();
    await channel.appendMessage(user("after reset"));

    const context = JSON.stringify((await channel.buildSessionContext()).messages);
    expect(context).toContain("after reset");
    expect(context).not.toContain("before reset");
    expect(JSON.stringify(await channel.getEntries())).toContain("before reset");
    await channel.close();
  });

  test("enforces one writer per session while allowing inspection and other sessions", async () => {
    const channel = await SessionStore.open(office, "C1");
    await expect(SessionStore.open(office, "C1")).rejects.toThrow("active writer");
    await expect(SessionStore.inspect(office, "C1")).resolves.toBeDefined();
    const thread = await SessionStore.open(office, "C1:1000.1");
    await thread.close();
    await channel.close();
    await (await SessionStore.open(office, "C1")).close();
  });

  test("close is idempotent, drains unawaited mutations, and closed methods fail", async () => {
    const store = await SessionStore.open(office, "C1");
    void store.appendMessage(user("unawaited"));
    await Promise.all([store.close(), store.close()]);
    expect(() => store.getSessionId()).toThrow("closed");
    expect(await contextText("C1")).toContain("unawaited");
  });

  test("context tokens come from the newest successful answer after compaction", async () => {
    const store = await SessionStore.inMemory();
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

  test("session name comes from the latest set name", async () => {
    const store = await SessionStore.inMemory();
    await store.setSessionName("first");
    await store.setSessionName("  second  ");
    expect(await store.getSessionName()).toBe("second");
    await store.setSessionName("   ");
    expect(await store.getSessionName()).toBeUndefined();
    await store.close();
  });

  test("an office without sessions has no storage and nothing to inspect", async () => {
    expect(await SessionStore.list(office)).toEqual([]);
    expect(await SessionStore.inspect(office, "C1")).toBeUndefined();
    expect(await SessionStore.inspectExecution(office, "C1")).toEqual({
      open: false,
      started: false,
    });
  });
});
