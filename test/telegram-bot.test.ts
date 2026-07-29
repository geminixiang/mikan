import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler, OfficeAddress } from "../src/adapter.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../src/office/index.js";
import type { Workspace } from "../src/office/index.js";
import { conversationIdOf } from "../src/sessions/session-key.js";

const officeOf = (sessionKey: string) =>
  createOfficeAddress("telegram", conversationIdOf(sessionKey));
import { TelegramMessagingBot } from "../src/adapters/telegram/bot.js";

function makeHandler(): MessagingEventHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
  };
}

function makeHandlerWithRunningKeys(runningKeys: string[]): MessagingEventHandler {
  const running = new Set(runningKeys);
  return {
    isRunning: vi.fn((_address: OfficeAddress, key: string) => running.has(key)),
    getRunningSessions: vi.fn().mockReturnValue(
      runningKeys.map((sessionKey) => ({
        address: officeOf(sessionKey),
        sessionKey,
        startedAt: Date.now(),
      })),
    ),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
  };
}

// Helper: build a fake Telegram message object
function makeMessage(overrides: Record<string, any> = {}) {
  return {
    message_id: 100,
    date: Math.floor(Date.now() / 1000) + 10,
    chat: { id: 123, type: "private" },
    from: { id: 42, is_bot: false, username: "alice", first_name: "Alice" },
    text: "hello",
    ...overrides,
  };
}

function installCommandHandler(
  bot: TelegramMessagingBot,
  command: string,
): (ctx: { message: any }) => Promise<void> {
  let commandHandler: ((ctx: { message: any }) => Promise<void>) | undefined;
  (bot as any).botUsername = "mikan_bot";
  (bot as any).client = {
    command: vi.fn((name: string, handlerFn: (ctx: { message: any }) => Promise<void>) => {
      if (name === command) commandHandler = handlerFn;
    }),
    on: vi.fn(),
  };
  (bot as any).setupEventHandlers();
  if (!commandHandler) throw new Error(`${command} handler not installed`);
  return commandHandler;
}

function installMessageHandler(
  bot: TelegramMessagingBot,
): (ctx: { message: any }) => Promise<void> {
  let messageHandler: ((ctx: { message: any }) => Promise<void>) | undefined;
  (bot as any).startupTime = 0;
  (bot as any).botUsername = "mikan_bot";
  (bot as any).processAttachments = vi.fn().mockResolvedValue([]);
  (bot as any).client = {
    command: vi.fn(),
    on: vi.fn((event: string, handlerFn: (ctx: { message: any }) => Promise<void>) => {
      if (event === "message") messageHandler = handlerFn;
    }),
  };
  (bot as any).setupEventHandlers();
  if (!messageHandler) throw new Error("message handler not installed");
  return messageHandler;
}

describe("TelegramMessagingBot /new routing", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-new-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test.each([
    ["private", "direct"],
    ["group", "shared"],
  ])("routes %s /new through the command DM gate", async (chatType, conversationKind) => {
    const handler = makeHandler();
    const bot = new TelegramMessagingBot(handler, { token: "T", workspace });
    const commandHandler = installCommandHandler(bot, "new");

    await commandHandler({
      message: makeMessage({ chat: { id: 123, type: chatType }, text: "/new" }),
    });

    expect(handler.handleNewCommand).not.toHaveBeenCalled();
    expect(handler.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKind, text: "/new" }),
      bot,
      expect.any(Object),
    );
  });
});

describe("TelegramMessagingBot extractMessageContext", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-ctx-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("returns null for null/undefined message", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    const extract = (bot as any).extractMessageContext.bind(bot);
    expect(extract(null)).toBeNull();
    expect(extract(undefined)).toBeNull();
  });

  test("returns null for messages before startup time", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    (bot as any).startupTime = Date.now() + 60_000;
    const extract = (bot as any).extractMessageContext.bind(bot);
    const msg = makeMessage({ date: Math.floor(Date.now() / 1000) });
    expect(extract(msg)).toBeNull();
  });

  test("returns null for bot messages", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);
    const msg = makeMessage({ from: { id: 1, is_bot: true, username: "bot" } });
    expect(extract(msg)).toBeNull();
  });

  test("private chat: sessionKey is just chatId (single session)", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg1 = makeMessage({ message_id: 100 });
    const msg2 = makeMessage({ message_id: 200 });
    expect(extract(msg1).sessionKey).toBe("123");
    expect(extract(msg2).sessionKey).toBe("123");
    // MessagingBoth produce the same sessionKey — same session!
    expect(extract(msg1).sessionKey).toBe(extract(msg2).sessionKey);
  });

  test("group chat: sessionKey includes msgId (per-message session)", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg = makeMessage({ chat: { id: 999, type: "group" }, message_id: 50 });
    expect(extract(msg).sessionKey).toBe("999:50");
  });

  test("group chat: reply uses threadTs in sessionKey", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg = makeMessage({
      chat: { id: 999, type: "group" },
      message_id: 60,
      reply_to_message: { message_id: 50 },
    });
    expect(extract(msg).sessionKey).toBe("999:50");
  });

  test("private chat reply still uses chatId as sessionKey", () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    (bot as any).startupTime = 0;
    const extract = (bot as any).extractMessageContext.bind(bot);

    const msg = makeMessage({ reply_to_message: { message_id: 50 } });
    expect(extract(msg).sessionKey).toBe("123");
    // threadTs is still set for reply targeting
    expect(extract(msg).threadTs).toBe("50");
  });
});

describe("TelegramMessagingBot stop handling", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-stop-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("bare stop in a group can stop the agent without an @mention", async () => {
    const handler = makeHandlerWithRunningKeys(["999:50"]);
    const bot = new TelegramMessagingBot(handler, { token: "T", workspace });
    let messageHandler: ((ctx: { message: any }) => Promise<void>) | undefined;
    const processAttachments = vi.fn().mockResolvedValue([]);

    (bot as any).startupTime = 0;
    (bot as any).botUsername = "mikan_bot";
    (bot as any).processAttachments = processAttachments;
    (bot as any).client = {
      command: vi.fn(),
      on: vi.fn((event: string, handlerFn: (ctx: { message: any }) => Promise<void>) => {
        if (event === "message") messageHandler = handlerFn;
      }),
    };

    (bot as any).setupEventHandlers();

    await messageHandler?.({
      message: makeMessage({
        chat: { id: 999, type: "group" },
        message_id: 70,
        text: "stop",
        reply_to_message: {
          message_id: 60,
          from: { id: 99, is_bot: true, username: "mikan_bot" },
        },
      }),
    });

    expect(handler.handleStop).toHaveBeenCalledWith(officeOf("999"), "999:50", bot);
    expect(processAttachments).not.toHaveBeenCalled();
  });
});

describe("TelegramMessagingBot message logging", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-log-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("logs threadTs for shared chat replies", async () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    const messageHandler = installMessageHandler(bot);

    await messageHandler({
      message: makeMessage({
        chat: { id: 999, type: "group" },
        message_id: 60,
        text: "@mikan_bot hello",
        reply_to_message: { message_id: 50 },
      }),
    });

    const lines = readFileSync(join(workingDir, officeKey(officeOf("999")), "log.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.threadTs).toBe("50");
    expect(entry.text).toBe("hello");
  });

  test("does not log threadTs for private chat replies", async () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "T", workspace });
    const messageHandler = installMessageHandler(bot);

    await messageHandler({
      message: makeMessage({
        message_id: 60,
        text: "hello",
        reply_to_message: { message_id: 50 },
      }),
    });

    const lines = readFileSync(join(workingDir, officeKey(officeOf("123")), "log.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.threadTs).toBeUndefined();
  });
});

describe("TelegramMessagingBot startup", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-start-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("start registers required Telegram slash commands only", async () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "TEST_TOKEN", workspace });
    const getMe = vi.fn().mockResolvedValue({ id: 99, username: "mikan_bot" });
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const command = vi.fn();
    const on = vi.fn();
    const start = vi.fn().mockResolvedValue(undefined);

    (bot as any).client = {
      api: { getMe, setMyCommands },
      command,
      on,
      start,
    };

    await bot.start();

    expect(setMyCommands).toHaveBeenCalledWith([
      { command: "login", description: "Store credentials in your private vault" },
      { command: "session", description: "Open the current session in the web viewer" },
      { command: "model", description: "Switch this conversation's LLM model" },
      { command: "sandbox", description: "Show or boost sandbox limits" },
      { command: "stop", description: "Stop ongoing conversation" },
      { command: "new", description: "Reset conversation history and start fresh" },
    ]);
  });
});

describe("TelegramMessagingBot HTML fallback", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-html-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("updateMessage retries with escaped HTML when Telegram rejects raw entities", async () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "TEST_TOKEN", workspace });
    const editMessageText = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Call to 'editMessageText' failed! (400: Bad Request: can't parse entities: Unsupported start tag \"id\")",
        ),
      )
      .mockResolvedValueOnce(undefined);

    (bot as any).client = { api: { editMessageText } };

    await bot.updateMessage("123", "456", "Usage: gws +read --id <ID>");

    expect(editMessageText).toHaveBeenNthCalledWith(1, 123, 456, "Usage: gws +read --id <ID>", {
      parse_mode: "HTML",
    });
    expect(editMessageText).toHaveBeenNthCalledWith(
      2,
      123,
      456,
      "Usage: gws +read --id &lt;ID&gt;",
      { parse_mode: "HTML" },
    );
  });
});

describe("TelegramMessagingBot attachments", () => {
  let workingDir: string;
  let workspace: Workspace;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    // Sibling state dir: the office registry journal never touches ~/.mikan.
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("processAttachments waits for downloads and returns completed metadata", async () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "TEST_TOKEN", workspace });
    const processTelegramFile = vi
      .fn()
      .mockResolvedValueOnce({ name: "photo_42.jpg", localPath: "123/attachments/1_photo.jpg" })
      .mockResolvedValueOnce({ name: "report.pdf", localPath: "123/attachments/2_report.pdf" });

    (bot as any).processTelegramFile = processTelegramFile;

    const attachments = await bot.processAttachments("123", {
      message_id: 42,
      photo: [{ file_id: "small-photo" }, { file_id: "large-photo" }],
      document: { file_id: "doc-1", file_name: "report.pdf" },
    });

    expect(processTelegramFile).toHaveBeenNthCalledWith(1, "123", "large-photo", "photo_42.jpg");
    expect(processTelegramFile).toHaveBeenNthCalledWith(2, "123", "doc-1", "report.pdf");
    expect(attachments).toEqual([
      { name: "photo_42.jpg", localPath: "123/attachments/1_photo.jpg" },
      { name: "report.pdf", localPath: "123/attachments/2_report.pdf" },
    ]);
  });

  test("processTelegramFile downloads via bot token and writes the attachment", async () => {
    const bot = new TelegramMessagingBot(makeHandler(), { token: "TEST_TOKEN", workspace });
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/file_123.jpg" });
    (bot as any).client = { api: { getFile } };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const attachment = await (bot as any).processTelegramFile("456", "file-id", "photo.jpg");

    expect(getFile).toHaveBeenCalledWith("file-id");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/file/botTEST_TOKEN/photos/file_123.jpg",
    );
    expect(attachment).toMatchObject({
      name: "photo.jpg",
      localPath: expect.stringMatching(
        new RegExp(
          `^${officeKey(createOfficeAddress("telegram", "456"))}/attachments/\\d+_photo\\.jpg$`,
        ),
      ),
    });

    const savedFile = join(workingDir, attachment.localPath);
    expect(existsSync(savedFile)).toBe(true);
    expect(readFileSync(savedFile)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
