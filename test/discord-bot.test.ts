import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection } from "discord.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler } from "../src/adapter.js";
import { DiscordMessagingBot } from "../src/adapters/discord/bot.js";

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

function installMessageHandler(bot: DiscordMessagingBot): (msg: any) => Promise<void> {
  let messageHandler: ((msg: any) => Promise<void>) | undefined;
  (bot as any).startupTime = 0;
  (bot as any).botUserId = "BOT";
  (bot as any).processAttachments = vi.fn().mockResolvedValue([]);
  (bot as any).client = {
    on: vi.fn((event: string, handlerFn: (msg: any) => Promise<void>) => {
      if (event === "messageCreate") messageHandler = handlerFn;
    }),
  };
  (bot as any).setupEventHandlers();
  if (!messageHandler) throw new Error("message handler not installed");
  return messageHandler;
}

function installInteractionHandler(bot: DiscordMessagingBot): (interaction: any) => Promise<void> {
  let interactionHandler: ((interaction: any) => Promise<void>) | undefined;
  (bot as any).client = {
    on: vi.fn((event: string, handlerFn: (payload: any) => Promise<void>) => {
      if (event === "interactionCreate") interactionHandler = handlerFn;
    }),
  };
  (bot as any).setupEventHandlers();
  if (!interactionHandler) throw new Error("interaction handler not installed");
  return interactionHandler;
}

function makeDiscordMessage(overrides: Record<string, any> = {}) {
  return {
    id: "M1",
    channelId: "C1",
    createdTimestamp: Date.now() + 10,
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    content: "<@BOT> hello",
    author: { id: "U1", username: "alice", bot: false },
    member: { displayName: "Alice" },
    channel: { type: 0, isThread: () => false, name: "general" },
    mentions: { users: { has: (id: string) => id === "BOT" } },
    reference: undefined,
    attachments: new Collection(),
    ...overrides,
  };
}

describe("DiscordMessagingBot attachments", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-discord-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("processAttachments waits for downloads and filters failures", async () => {
    const bot = new DiscordMessagingBot(makeHandler(), { token: "TEST_TOKEN", workingDir });
    const downloadAttachment = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("boom"));

    (bot as any).downloadAttachment = downloadAttachment;

    const attachments = new Collection<string, any>([
      ["a", { name: "clip.mov", url: "https://example.com/clip.mov" }],
      ["b", { name: "broken.mov", url: "https://example.com/broken.mov" }],
    ]);

    const result = await bot.processAttachments("C123", attachments as any, "M1");

    expect(downloadAttachment).toHaveBeenNthCalledWith(
      1,
      join(workingDir, "C123", "attachments"),
      expect.stringMatching(/^\d+_clip\.mov$/),
      "https://example.com/clip.mov",
    );
    expect(downloadAttachment).toHaveBeenNthCalledWith(
      2,
      join(workingDir, "C123", "attachments"),
      expect.stringMatching(/^\d+_broken\.mov$/),
      "https://example.com/broken.mov",
    );
    expect(result).toEqual([
      {
        name: "clip.mov",
        localPath: expect.stringMatching(/^C123\/attachments\/\d+_clip\.mov$/),
      },
    ]);
  });
});

describe("DiscordMessagingBot message routing", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-discord-route-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("uses a persistent session key for DMs", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "DMMSG1",
        channelId: "DM1",
        content: "hello",
        channel: { type: 1, isThread: () => false },
        mentions: { users: { has: () => false } },
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    const event = vi.mocked(handler.handleEvent).mock.calls[0][0];
    expect(event.sessionKey).toBe("DM1");
  });

  test("uses a persistent top-level session key for shared channels", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M1",
        channelId: "C1",
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    const event = vi.mocked(handler.handleEvent).mock.calls[0][0];
    expect(event.sessionKey).toBe("C1");
  });

  test("uses reply target as the scoped session key in shared channels", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        reference: { messageId: "M1" },
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    const event = vi.mocked(handler.handleEvent).mock.calls[0][0];
    expect(event.sessionKey).toBe("C1:M1");
  });

  test("uses parent channel as conversationId for Discord thread channels", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "THREAD1",
        content: "thread message",
        mentions: { users: { has: () => false } },
        channel: {
          type: 11,
          isThread: () => true,
          parentId: "C1",
          name: "thread-topic",
        },
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C1",
      sessionKey: "C1:THREAD1",
      thread_ts: "THREAD1",
      text: "thread message",
    });
  });

  test("shared-channel replies trigger without a mention", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "reply without mention",
        mentions: { users: { has: () => false } },
        reference: { messageId: "M1" },
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C1",
      sessionKey: "C1:M1",
      text: "reply without mention",
      thread_ts: "M1",
    });
  });

  test("shared-channel top-level messages still require a mention", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "top-level without mention",
        mentions: { users: { has: () => false } },
      }),
    );

    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("queues shared top-level follow-up messages instead of posting already-working", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((sessionKey: string) => sessionKey === "C1");

    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    const queue = (bot as any).getQueue("C1");
    queue.processing = true;
    (bot as any).postMessage = vi.fn().mockResolvedValue("BOT_MSG");

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "<@BOT> second request",
      }),
    );

    expect((bot as any).postMessage).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C1",
      sessionKey: "C1",
      text: "second request",
    });
  });

  test("stop from a shared-channel reply can stop the running top-level session", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((sessionKey: string) => sessionKey === "C1");

    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "<@BOT> stop",
        reference: { messageId: "M1" },
      }),
    );

    expect(handler.handleStop).toHaveBeenCalledWith("C1", "C1", bot);
  });

  test("logs threadTs for shared channel replies", async () => {
    const bot = new DiscordMessagingBot(makeHandler(), { token: "TEST_TOKEN", workingDir });
    const messageHandler = installMessageHandler(bot);

    await messageHandler(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        reference: { messageId: "M1" },
      }),
    );

    const lines = readFileSync(join(workingDir, "C1", "log.jsonl"), "utf-8")
      .trim()
      .split("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry.threadTs).toBe("M1");
  });

  test("platform info defaults to hiding usage summary", () => {
    const bot = new DiscordMessagingBot(makeHandler(), { token: "TEST_TOKEN", workingDir });

    expect(bot.getMessagingInfo().diagnostics?.showUsageSummary).toBe(false);
  });

  test("/session slash command in shared channels replies ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("session link");
    });

    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const interactionHandler = installInteractionHandler(bot);

    const reply = vi.fn().mockResolvedValue(undefined);

    await interactionHandler({
      isChatInputCommand: () => true,
      commandName: "session",
      channelId: "C1",
      inGuild: () => true,
      channel: { isThread: () => false },
      id: "I1",
      createdTimestamp: Date.now(),
      user: { id: "U1", username: "alice" },
      replied: false,
      deferred: false,
      reply,
      followUp: vi.fn(),
      editReply: vi.fn(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "dm",
      conversationId: "C1",
      conversationKind: "shared",
      sessionKey: "C1",
      text: "/session",
    });
    expect(reply).toHaveBeenCalledWith({
      content: "session link",
      ephemeral: true,
    });
  });

  test("/session slash command in a Discord thread uses parent channel conversationId", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("session link");
    });

    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const interactionHandler = installInteractionHandler(bot);

    await interactionHandler({
      isChatInputCommand: () => true,
      commandName: "session",
      channelId: "THREAD1",
      inGuild: () => true,
      channel: { isThread: () => true, parentId: "C1" },
      id: "I2",
      createdTimestamp: Date.now(),
      user: { id: "U1", username: "alice" },
      replied: false,
      deferred: false,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn(),
      editReply: vi.fn(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C1",
      sessionKey: "C1:THREAD1",
      thread_ts: "THREAD1",
      text: "/session",
    });
  });

  test("/new slash command resets the resolved session and acknowledges", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const interactionHandler = installInteractionHandler(bot);
    const reply = vi.fn().mockResolvedValue(undefined);

    await interactionHandler({
      isChatInputCommand: () => true,
      commandName: "new",
      channelId: "DM1",
      inGuild: () => false,
      channel: { isThread: () => false },
      id: "I3",
      createdTimestamp: Date.now(),
      user: { id: "U1", username: "alice" },
      replied: false,
      deferred: false,
      reply,
      followUp: vi.fn(),
      editReply: vi.fn(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "DM1",
      conversationKind: "direct",
      sessionKey: "DM1",
      text: "/new",
    });
    expect(reply).not.toHaveBeenCalled();
  });

  test("/new slash command in a guild routes through the command DM gate", async () => {
    const handler = makeHandler();
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const interactionHandler = installInteractionHandler(bot);

    await interactionHandler({
      isChatInputCommand: () => true,
      commandName: "new",
      channelId: "C1",
      inGuild: () => true,
      channel: { isThread: () => false },
      id: "I3-GUILD",
      createdTimestamp: Date.now(),
      user: { id: "U1", username: "alice" },
      replied: false,
      deferred: false,
      reply: vi.fn(),
      followUp: vi.fn(),
      editReply: vi.fn(),
    });

    expect(handler.handleNewCommand).not.toHaveBeenCalled();
    expect(handler.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKind: "shared", text: "/new" }),
      bot,
      expect.any(Object),
    );
  });

  test("/stop slash command targets the thread session and acknowledges", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (sessionKey: string) => sessionKey === "C1:THREAD1",
    );
    const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workingDir });
    const interactionHandler = installInteractionHandler(bot);
    const reply = vi.fn().mockResolvedValue(undefined);

    await interactionHandler({
      isChatInputCommand: () => true,
      commandName: "stop",
      channelId: "THREAD1",
      inGuild: () => true,
      channel: { isThread: () => true, parentId: "C1" },
      id: "I4",
      createdTimestamp: Date.now(),
      user: { id: "U1", username: "alice" },
      replied: false,
      deferred: false,
      reply,
      followUp: vi.fn(),
      editReply: vi.fn(),
    });

    expect(handler.handleStop).toHaveBeenCalledWith("C1:THREAD1", "C1", bot);
    expect(reply).toHaveBeenCalledWith({
      content: "Stopped the current conversation.",
      ephemeral: true,
    });
  });
});
