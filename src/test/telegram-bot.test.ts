import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, Document, Message, PhotoSize, User, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationEvent, MessagingEventHandler, OfficeAddress } from "../types.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import type { Workspace } from "../office/types.js";
import { conversationIdOf } from "../sessions/session-key.js";

import { TelegramMessagingBot } from "../adapters/telegram/bot.js";
import type { TelegramClient, TelegramUpdateHandler } from "../adapters/telegram/types.js";

const officeOf = (sessionKey: string) =>
  createOfficeAddress("telegram", conversationIdOf(sessionKey));

function makePhotoSize(fileId: string): PhotoSize {
  return { file_id: fileId, file_unique_id: `unique-${fileId}`, width: 100, height: 100 };
}

function makeDocument(fileId: string, fileName: string): Document {
  return { file_id: fileId, file_unique_id: `unique-${fileId}`, file_name: fileName };
}

function makeAttachmentMessage(
  fields: Pick<Message, "message_id" | "photo" | "document">,
): Message {
  return {
    date: Math.floor(Date.now() / 1000),
    chat: { id: 123, type: "private", first_name: "Alice" },
    ...fields,
  };
}

function requireFirstLine(lines: string[]): string {
  const line = lines[0];
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

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

type TelegramApi = TelegramClient["api"];

const unexpectedApiCall = async (): Promise<never> => {
  throw new Error("unexpected Telegram API call");
};

const BOT_USER: UserFromGetMe = {
  id: 99,
  is_bot: true,
  first_name: "Mikan",
  username: "mikan_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

class FakeTelegramClient implements TelegramClient {
  readonly api: TelegramApi;
  private readonly commands = new Map<string, TelegramUpdateHandler>();
  private messageHandler: TelegramUpdateHandler | undefined;

  constructor(api: Partial<TelegramApi> = {}) {
    this.api = {
      getMe: async () => BOT_USER,
      setMyCommands: async () => true,
      setMessageReaction: unexpectedApiCall,
      editMessageText: unexpectedApiCall,
      sendRichMessage: unexpectedApiCall,
      sendMessage: unexpectedApiCall,
      deleteMessage: unexpectedApiCall,
      sendChatAction: unexpectedApiCall,
      sendDocument: unexpectedApiCall,
      getFile: unexpectedApiCall,
      ...api,
    };
  }

  catch(): void {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  command(command: string, handler: TelegramUpdateHandler): void {
    this.commands.set(command, handler);
  }

  on(_filter: "message", handler: TelegramUpdateHandler): void {
    this.messageHandler = handler;
  }

  deliverCommand(command: string, message: Message | undefined): Promise<void> {
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`${command} handler not installed`);
    return handler({ message });
  }

  deliverMessage(message: Message | undefined): Promise<void> {
    if (!this.messageHandler) throw new Error("message handler not installed");
    return this.messageHandler({ message });
  }
}

interface StartedTelegramBot {
  bot: TelegramMessagingBot;
  client: FakeTelegramClient;
}

async function startBot(
  handler: MessagingEventHandler,
  workspace: Workspace,
  api: Partial<TelegramApi> = {},
): Promise<StartedTelegramBot> {
  const client = new FakeTelegramClient(api);
  const bot = new TelegramMessagingBot(handler, { token: "T", workspace, client });
  await bot.start();
  return { bot, client };
}

function privateChat(id: number): Chat.PrivateChat {
  return { id, type: "private", first_name: "Alice" };
}

function groupChat(id: number): Chat.GroupChat {
  return { id, type: "group", title: "Team" };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 100,
    date: Math.floor(Date.now() / 1000) + 10,
    chat: privateChat(123),
    from: { id: 42, is_bot: false, username: "alice", first_name: "Alice" },
    text: "hello",
    ...overrides,
  };
}

function replyTo(messageId: number, from?: User): Message & { reply_to_message: undefined } {
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: privateChat(123),
    from,
    reply_to_message: undefined,
  };
}

function handledEvent(handler: MessagingEventHandler, index = 0): ConversationEvent {
  const call = vi.mocked(handler.handleEvent).mock.calls[index];
  if (!call) throw new Error(`handleEvent call ${index} missing`);
  return call[0];
}

function officeLogPath(workingDir: string, sessionKey: string): string {
  return join(workingDir, officeKey(officeOf(sessionKey)), "log.jsonl");
}

describe("TelegramMessagingBot /new routing", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-new-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test.each([
    ["private", privateChat(123), "direct"],
    ["group", groupChat(123), "shared"],
  ])("routes %s /new through the command DM gate", async (_chatType, chat, conversationKind) => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverCommand("new", makeMessage({ chat, text: "/new" }));

    expect(handler.handleNewCommand).not.toHaveBeenCalled();
    expect(handler.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKind, text: "/new" }),
      bot,
      expect.any(Object),
    );
  });
});

describe("TelegramMessagingBot message context", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-ctx-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("ignores updates without a message", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(undefined);
    await client.deliverCommand("new", undefined);
    await bot.stop();

    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(existsSync(officeLogPath(workingDir, "123"))).toBe(false);
  });

  test("ignores messages sent before startup", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(makeMessage({ date: Math.floor(Date.now() / 1000) - 60 }));
    await bot.stop();

    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(existsSync(officeLogPath(workingDir, "123"))).toBe(false);
  });

  test("ignores bot messages", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(
      makeMessage({ from: { id: 1, is_bot: true, username: "bot", first_name: "Bot" } }),
    );
    await bot.stop();

    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(existsSync(officeLogPath(workingDir, "123"))).toBe(false);
  });

  test("private chat: sessionKey is just chatId (single session)", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(makeMessage({ message_id: 100 }));
    await client.deliverMessage(makeMessage({ message_id: 200 }));
    await bot.stop();

    expect(handledEvent(handler, 0).sessionKey).toBe("123");
    expect(handledEvent(handler, 1).sessionKey).toBe("123");
    expect(handledEvent(handler, 0).sessionKey).toBe(handledEvent(handler, 1).sessionKey);
  });

  test("group chat: sessionKey includes msgId (per-message session)", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(
      makeMessage({ chat: groupChat(999), message_id: 50, text: "@mikan_bot hello" }),
    );
    await bot.stop();

    expect(handledEvent(handler).sessionKey).toBe("999:50");
  });

  test("group chat: reply uses threadTs in sessionKey", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(
      makeMessage({
        chat: groupChat(999),
        message_id: 60,
        text: "@mikan_bot hello",
        reply_to_message: replyTo(50),
      }),
    );
    await bot.stop();

    expect(handledEvent(handler).sessionKey).toBe("999:50");
  });

  test("private chat reply still uses chatId as sessionKey", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    await client.deliverMessage(makeMessage({ reply_to_message: replyTo(50) }));
    await bot.stop();

    expect(handledEvent(handler).sessionKey).toBe("123");
    expect(handledEvent(handler).thread_ts).toBe("50");
  });
});

describe("TelegramMessagingBot stop handling", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-stop-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("bare stop in a group can stop the agent without an @mention", async () => {
    const handler = makeHandlerWithRunningKeys(["999:50"]);
    const getFile = vi.fn<TelegramApi["getFile"]>(unexpectedApiCall);
    const { bot, client } = await startBot(handler, workspace, { getFile });

    await client.deliverMessage(
      makeMessage({
        chat: groupChat(999),
        message_id: 70,
        text: "stop",
        document: makeDocument("stop-doc", "notes.txt"),
        reply_to_message: replyTo(60, {
          id: 99,
          is_bot: true,
          username: "mikan_bot",
          first_name: "Mikan",
        }),
      }),
    );

    expect(handler.handleStop).toHaveBeenCalledWith(officeOf("999"), "999:50", bot, "60");
    expect(getFile).not.toHaveBeenCalled();
  });
});

describe("TelegramMessagingBot message logging", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-log-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("logs threadTs for shared chat replies", async () => {
    const { client } = await startBot(makeHandler(), workspace);

    await client.deliverMessage(
      makeMessage({
        chat: groupChat(999),
        message_id: 60,
        text: "@mikan_bot hello",
        reply_to_message: replyTo(50),
      }),
    );

    const lines = readFileSync(officeLogPath(workingDir, "999"), "utf-8").trim().split("\n");
    const entry = JSON.parse(requireFirstLine(lines));
    expect(entry.threadTs).toBe("50");
    expect(entry.text).toBe("hello");
  });

  test("does not log threadTs for private chat replies", async () => {
    const { client } = await startBot(makeHandler(), workspace);

    await client.deliverMessage(
      makeMessage({
        message_id: 60,
        text: "hello",
        reply_to_message: replyTo(50),
      }),
    );

    const lines = readFileSync(officeLogPath(workingDir, "123"), "utf-8").trim().split("\n");
    const entry = JSON.parse(requireFirstLine(lines));
    expect(entry.threadTs).toBeUndefined();
  });
});

describe("TelegramMessagingBot startup", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-start-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("start registers required Telegram slash commands only", async () => {
    const setMyCommands = vi.fn<TelegramApi["setMyCommands"]>(async () => true);

    await startBot(makeHandler(), workspace, { setMyCommands });

    expect(setMyCommands).toHaveBeenCalledWith([
      { command: "login", description: "Store credentials in your private vault" },
      { command: "session", description: "Open the current session in the web viewer" },
      { command: "model", description: "Switch this conversation's LLM model" },
      { command: "sandbox", description: "Show or boost sandbox limits" },
      { command: "stop", description: "Stop ongoing conversation" },
      { command: "new", description: "Reset conversation history and start fresh" },
      { command: "admin", description: "Open the admin portal" },
    ]);
  });
});

describe("TelegramMessagingBot attachments", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-telegram-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("processAttachments waits for downloads and returns completed metadata", async () => {
    const getFile = vi.fn<TelegramApi["getFile"]>(async (fileId) => ({
      file_id: fileId,
      file_unique_id: `unique-${fileId}`,
      file_path: `files/${fileId}`,
    }));
    const bot = new TelegramMessagingBot(makeHandler(), {
      token: "TEST_TOKEN",
      workspace,
      client: new FakeTelegramClient({ getFile }),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(new Uint8Array([1, 2, 3, 4])),
    );

    const attachments = await bot.processAttachments(
      "123",
      makeAttachmentMessage({
        message_id: 42,
        photo: [makePhotoSize("small-photo"), makePhotoSize("large-photo")],
        document: makeDocument("doc-1", "report.pdf"),
      }),
    );

    expect(getFile).toHaveBeenCalledWith("large-photo");
    expect(getFile).toHaveBeenCalledWith("doc-1");
    expect(getFile).not.toHaveBeenCalledWith("small-photo");
    const key = officeKey(createOfficeAddress("telegram", "123"));
    expect(attachments).toEqual([
      {
        name: "photo_42.jpg",
        localPath: expect.stringMatching(new RegExp(`^${key}/attachments/\\d+_photo_42\\.jpg$`)),
      },
      {
        name: "report.pdf",
        localPath: expect.stringMatching(new RegExp(`^${key}/attachments/\\d+_report\\.pdf$`)),
      },
    ]);
    for (const attachment of attachments) {
      expect(existsSync(join(workingDir, attachment.localPath))).toBe(true);
    }
  });

  test("attachment downloads go via the bot token and write the file", async () => {
    const getFile = vi.fn<TelegramApi["getFile"]>(async (fileId) => ({
      file_id: fileId,
      file_unique_id: `unique-${fileId}`,
      file_path: "photos/file_123.jpg",
    }));
    const bot = new TelegramMessagingBot(makeHandler(), {
      token: "TEST_TOKEN",
      workspace,
      client: new FakeTelegramClient({ getFile }),
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(new Uint8Array([1, 2, 3, 4])));

    const [attachment] = await bot.processAttachments(
      "456",
      makeAttachmentMessage({ message_id: 7, document: makeDocument("file-id", "photo.jpg") }),
    );

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

    if (!attachment) throw new Error("expected one downloaded attachment");
    const savedFile = join(workingDir, attachment.localPath);
    expect(existsSync(savedFile)).toBe(true);
    expect(readFileSync(savedFile)).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
