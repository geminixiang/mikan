import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../sessions/session-store.js";
import { RUN_CAUSE_CUSTOM_TYPE } from "../sessions/types.js";
import { ChatHistorySync } from "../sessions/chat-history-sync.js";
import { formatHistoryLine } from "../sessions/history-line.js";
import { isCommandText } from "../adapters/commands/manifest.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";

const BUSY_TEXT = "busy-queue e2e: run `sleep 10`, then reply with this token: QA_BUSY_TOKEN";
const QUEUED_TEXT = "queue test: reply with this token directly: QA_QUEUED_TOKEN";
const SESSION_KEY = "C123";

let root: string;
let office: Office;
let conversationDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "queued-message-context-"));
  office = createWorkspace({ root: join(root, "workspace"), stateDir: join(root, "state") }).office(
    createOfficeAddress("slack", "C123"),
  );
  conversationDir = office.dir;
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const EARLIER_TURN = [
  {
    date: "2026-05-01T00:00:00.000Z",
    ts: "1000.0001",
    user: "U1",
    userName: "alice",
    text: "earlier question",
    isMessagingBot: false,
  },
  {
    date: "2026-05-01T00:00:01.000Z",
    ts: "1000.0002",
    user: "bot",
    text: "earlier answer",
    isMessagingBot: true,
  },
];
const BUSY_RECORD = {
  date: "2026-05-01T00:00:02.000Z",
  ts: "1000.0003",
  user: "U1",
  userName: "alice",
  text: BUSY_TEXT,
  isMessagingBot: false,
};
const QUEUED_RECORD = {
  date: "2026-05-01T00:00:03.000Z",
  ts: "1000.0004",
  user: "U1",
  userName: "alice",
  text: QUEUED_TEXT,
  isMessagingBot: false,
};
const BUSY_REPLY_RECORD = {
  date: "2026-05-01T00:00:12.000Z",
  ts: "1000.0005",
  user: "bot",
  text: "QA_BUSY_TOKEN",
  isMessagingBot: true,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function writeLog(entries: object[]): void {
  writeFileSync(
    join(conversationDir, "log.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf-8",
  );
}

function newManager(): ChatHistorySync {
  return new ChatHistorySync({
    isCommandText,
    recentDays: 7,
    maxTopLevelMessages: 20,
    now: () => new Date("2026-05-01T00:00:13.000Z"),
  });
}

async function syncForTurn(
  manager: ChatHistorySync,
  contextFile: string,
  currentMessageId: string,
) {
  const session = await SessionStore.open(office, contextFile);
  try {
    await manager.syncSessionManager({
      office,
      sessionKey: SESSION_KEY,
      sessionManager: session,
      currentMessageId,
    });
  } finally {
    await session.close();
  }
}

async function appendTurn(
  contextFile: string,
  prompt: string,
  answer: string | undefined,
  timestamp: number,
  messageId: string,
): Promise<void> {
  const session = await SessionStore.open(office, contextFile);
  try {
    await session.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId });
    await session.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: formatHistoryLine({ date: new Date(), userName: "alice", text: prompt }),
        },
      ],
      timestamp,
    });
    if (answer === undefined) return;
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: answer }],
      api: "platform-history",
      provider: "platform-history",
      model: "platform-history",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: timestamp + 1,
    });
  } finally {
    await session.close();
  }
}

async function providerMessages(
  contextFile: string,
): Promise<Array<{ role: string; text: string }>> {
  const inspection = await SessionStore.inspect(office, contextFile);
  if (!inspection) throw new Error(`No session ${contextFile}`);
  const context = await inspection.buildSessionContext();
  return context.messages.map((message) => {
    return {
      role: message.role,
      text:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    };
  });
}

async function runBusyThenQueuedTurns(): Promise<string> {
  writeLog([...EARLIER_TURN, BUSY_RECORD]);
  const manager = newManager();
  await manager.resolveSessionScope({
    office,
    sessionKey: SESSION_KEY,
    currentMessageId: BUSY_RECORD.ts,
  });
  const scope = { contextFile: SESSION_KEY };

  await syncForTurn(manager, scope.contextFile, BUSY_RECORD.ts);
  await appendTurn(scope.contextFile, BUSY_TEXT, "QA_BUSY_TOKEN", 3, BUSY_RECORD.ts);

  writeLog([...EARLIER_TURN, BUSY_RECORD, QUEUED_RECORD, BUSY_REPLY_RECORD]);

  await syncForTurn(manager, scope.contextFile, QUEUED_RECORD.ts);
  return scope.contextFile;
}

async function appendToolCallTurn(contextFile: string): Promise<void> {
  const session = await SessionStore.open(office, contextFile);
  try {
    await session.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: BUSY_RECORD.ts });
    await session.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: formatHistoryLine({ date: new Date(), userName: "alice", text: BUSY_TEXT }),
        },
      ],
      timestamp: 3,
    });
    await session.appendMessage({
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 10" } },
      ],
      api: "platform-history",
      provider: "platform-history",
      model: "platform-history",
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: 4,
    });
    await session.appendMessage({
      role: "toolResult",
      content: [{ type: "text", text: "" }],
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
      timestamp: 5,
    } as never);
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "QA_BUSY_TOKEN" }],
      api: "platform-history",
      provider: "platform-history",
      model: "platform-history",
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: 6,
    });
  } finally {
    await session.close();
  }
}

describe("queued message context", () => {
  test("the queued turn's sync does not re-inject the busy instruction", async () => {
    const contextFile = await runBusyThenQueuedTurns();

    const userTexts = (await providerMessages(contextFile))
      .filter((message) => message.role === "user")
      .map((message) => message.text);
    expect(userTexts.filter((text) => text.includes(BUSY_TEXT))).toHaveLength(1);
  });

  test("the queued turn prompts with the queued message, not the busy one", async () => {
    const contextFile = await runBusyThenQueuedTurns();
    await appendTurn(contextFile, QUEUED_TEXT, undefined, 6, QUEUED_RECORD.ts);

    const messages = await providerMessages(contextFile);
    const lastUser = messages.findLast((message) => message.role === "user");
    expect(lastUser?.text).toContain("QA_QUEUED_TOKEN");
    expect(lastUser?.text).not.toContain("QA_BUSY_TOKEN");

    expect(messages.at(-1)?.text).toContain("QA_QUEUED_TOKEN");
    expect(messages.at(-2)).toEqual({ role: "assistant", text: "QA_BUSY_TOKEN" });
  });

  test("a busy turn answered through a tool call is still recognised as represented", async () => {
    writeLog([...EARLIER_TURN, BUSY_RECORD]);
    const manager = newManager();
    await manager.resolveSessionScope({
      office,
      sessionKey: SESSION_KEY,
      currentMessageId: BUSY_RECORD.ts,
    });
    const scope = { contextFile: SESSION_KEY };
    await syncForTurn(manager, scope.contextFile, BUSY_RECORD.ts);
    await appendToolCallTurn(scope.contextFile);

    writeLog([...EARLIER_TURN, BUSY_RECORD, QUEUED_RECORD, BUSY_REPLY_RECORD]);
    await syncForTurn(manager, scope.contextFile, QUEUED_RECORD.ts);
    await appendTurn(scope.contextFile, QUEUED_TEXT, undefined, 8, QUEUED_RECORD.ts);

    const userTexts = (await providerMessages(scope.contextFile))
      .filter((message) => message.role === "user")
      .map((message) => message.text);
    expect(userTexts.filter((text) => text.includes(BUSY_TEXT))).toHaveLength(1);
    expect(userTexts.at(-1)).toContain("QA_QUEUED_TOKEN");
    expect(userTexts.at(-1)).not.toContain("QA_BUSY_TOKEN");
  });
});
