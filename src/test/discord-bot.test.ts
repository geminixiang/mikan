import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, Collection, Events, type Guild } from "discord.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler } from "../types.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import type { Workspace } from "../office/types.js";
import { DiscordMessagingBot } from "../adapters/discord/bot.js";
import type {
  DiscordAttachmentSource,
  DiscordClient,
  DiscordCommandInteraction,
  DiscordIncomingChannel,
  DiscordIncomingMessage,
  DiscordReadyClient,
} from "../adapters/discord/types.js";

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

const READY_CLIENT: DiscordReadyClient = {
  user: { id: "BOT", tag: "mikan#0001" },
  application: { commands: { set: async () => undefined } },
};

class FakeDiscordClient extends EventEmitter implements DiscordClient {
  readonly channels = { fetch: vi.fn(async (_channelId: string) => null) };
  readonly users = {
    fetch: async (): Promise<never> => {
      throw new Error("unexpected Discord user fetch");
    },
  };
  readonly guilds = { cache: new Collection<string, Guild>() };

  async login(): Promise<string> {
    this.emit(Events.ClientReady, READY_CLIENT);
    return "logged-in";
  }

  async destroy(): Promise<void> {}

  deliverMessage(message: DiscordIncomingMessage): void {
    this.emit(Events.MessageCreate, message);
  }

  deliverInteraction(interaction: DiscordCommandInteraction): void {
    this.emit(Events.InteractionCreate, interaction);
  }
}

interface FakeCommandInteractionFields {
  id: string;
  commandName: string;
  channelId: string;
  inGuild: boolean;
  channel: DiscordIncomingChannel | null;
}

class FakeCommandInteraction implements DiscordCommandInteraction {
  readonly id: string;
  readonly commandName: string;
  readonly channelId: string;
  readonly channel: DiscordIncomingChannel | null;
  readonly createdTimestamp = Date.now();
  readonly user = { id: "U1", username: "alice" };
  readonly options = { getString: (_name: string): string | null => null };
  readonly replied = false;
  readonly deferred = false;
  readonly reply = vi.fn<DiscordCommandInteraction["reply"]>(async () => undefined);
  readonly followUp = vi.fn<DiscordCommandInteraction["followUp"]>(async () => undefined);
  readonly editReply = vi.fn<DiscordCommandInteraction["editReply"]>(async () => undefined);
  readonly deferReply = vi.fn<DiscordCommandInteraction["deferReply"]>(async () => undefined);
  private readonly guild: boolean;

  constructor(fields: FakeCommandInteractionFields) {
    this.id = fields.id;
    this.commandName = fields.commandName;
    this.channelId = fields.channelId;
    this.channel = fields.channel;
    this.guild = fields.inGuild;
  }

  isChatInputCommand(): this is DiscordCommandInteraction {
    return true;
  }

  inGuild(): boolean {
    return this.guild;
  }
}

interface StartedDiscordBot {
  bot: DiscordMessagingBot;
  client: FakeDiscordClient;
}

async function startBot(
  handler: MessagingEventHandler,
  workspace: Workspace,
): Promise<StartedDiscordBot> {
  const client = new FakeDiscordClient();
  const bot = new DiscordMessagingBot(handler, { token: "TEST_TOKEN", workspace, client });
  await bot.start();
  return { bot, client };
}

function firstHandledEvent(handler: MessagingEventHandler) {
  const call = vi.mocked(handler.handleEvent).mock.calls[0];
  if (!call) throw new Error("handleEvent was not called");
  return call[0];
}

function requireFirstLine(lines: string[]): string {
  const line = lines[0];
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

function readOfficeLog(workingDir: string, conversationId: string): string[] {
  return readFileSync(
    join(workingDir, officeKey(createOfficeAddress("discord", conversationId)), "log.jsonl"),
    "utf-8",
  )
    .trim()
    .split("\n");
}

const guildTextChannel: DiscordIncomingChannel = {
  type: ChannelType.GuildText,
  isThread: () => false,
  name: "general",
};

const dmChannel: DiscordIncomingChannel = { type: ChannelType.DM, isThread: () => false };

function threadChannel(parentId: string, name: string): DiscordIncomingChannel {
  return { type: ChannelType.PublicThread, isThread: () => true, parentId, name };
}

const noMentions = { users: { has: () => false } };

function makeDiscordMessage(
  overrides: Partial<DiscordIncomingMessage> = {},
): DiscordIncomingMessage {
  return {
    id: "M1",
    channelId: "C1",
    createdTimestamp: Date.now() + 10,
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    content: "<@BOT> hello",
    author: { id: "U1", username: "alice", bot: false },
    member: { displayName: "Alice" },
    channel: guildTextChannel,
    mentions: { users: { has: (id: string) => id === "BOT" } },
    reference: null,
    attachments: new Map<string, DiscordAttachmentSource>(),
    ...overrides,
  };
}

describe("DiscordMessagingBot attachments", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-discord-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("processAttachments waits for downloads and filters failures", async () => {
    const bot = new DiscordMessagingBot(makeHandler(), {
      token: "TEST_TOKEN",
      workspace,
      client: new FakeDiscordClient(),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("clip.mov")) return new Response(new Uint8Array([1, 2, 3]));
      return new Response(null, { status: 404, statusText: "Not Found" });
    });

    const attachments = new Map<string, DiscordAttachmentSource>([
      ["a", { name: "clip.mov", url: "https://example.com/clip.mov" }],
      ["b", { name: "broken.mov", url: "https://example.com/broken.mov" }],
    ]);

    const result = await bot.processAttachments("C123", attachments);

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/clip.mov");
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/broken.mov");
    expect(result).toEqual([
      {
        name: "clip.mov",
        localPath: expect.stringMatching(
          new RegExp(
            `^${officeKey(createOfficeAddress("discord", "C123"))}/attachments/\\d+_clip\\.mov$`,
          ),
        ),
      },
    ]);
    const [downloaded] = result;
    if (!downloaded) throw new Error("expected one downloaded attachment");
    expect(existsSync(join(workingDir, downloaded.localPath))).toBe(true);
  });
});

describe("DiscordMessagingBot message routing", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-discord-route-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
    workspace = createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("uses a persistent session key for DMs", async () => {
    const handler = makeHandler();
    const { client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "DMMSG1",
        channelId: "DM1",
        content: "hello",
        channel: dmChannel,
        mentions: noMentions,
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    const event = firstHandledEvent(handler);
    expect(event.sessionKey).toBe("DM1");
  });

  test("uses a persistent top-level session key for shared channels", async () => {
    const handler = makeHandler();
    const { client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M1",
        channelId: "C1",
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    const event = firstHandledEvent(handler);
    expect(event.sessionKey).toBe("C1");
  });

  test("uses reply target as the scoped session key in shared channels", async () => {
    const handler = makeHandler();
    const { client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        reference: { messageId: "M1" },
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    const event = firstHandledEvent(handler);
    expect(event.sessionKey).toBe("C1:M1");
  });

  test("uses parent channel as conversationId for Discord thread channels", async () => {
    const handler = makeHandler();
    const { client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M2",
        channelId: "THREAD1",
        content: "thread message",
        mentions: noMentions,
        channel: threadChannel("C1", "thread-topic"),
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C1" },
      sessionKey: "C1:THREAD1",
      thread_ts: "THREAD1",
      text: "thread message",
    });
  });

  test("shared-channel replies trigger without a mention", async () => {
    const handler = makeHandler();
    const { client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "reply without mention",
        mentions: noMentions,
        reference: { messageId: "M1" },
      }),
    );

    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalled();
    });
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C1" },
      sessionKey: "C1:M1",
      text: "reply without mention",
      thread_ts: "M1",
    });
  });

  test("shared-channel top-level messages still require a mention", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "top-level without mention",
        mentions: noMentions,
      }),
    );
    await bot.stop();

    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("queues shared top-level follow-up messages instead of posting already-working", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((_address, sessionKey) => sessionKey === "C1");
    let finishFirstRun: (() => void) | undefined;
    vi.mocked(handler.handleEvent).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstRun = resolve;
        }),
    );

    const { bot, client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({ id: "M1", channelId: "C1", content: "<@BOT> first request" }),
    );
    await vi.waitFor(() => {
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });

    client.deliverMessage(
      makeDiscordMessage({ id: "M2", channelId: "C1", content: "<@BOT> second request" }),
    );
    await vi.waitFor(() => {
      expect(readOfficeLog(workingDir, "C1")).toHaveLength(2);
    });

    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    finishFirstRun?.();
    await bot.stop();

    expect(handler.handleEvent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(handler.handleEvent).mock.calls[1]?.[0]).toMatchObject({
      address: { conversationId: "C1" },
      sessionKey: "C1",
      text: "second request",
    });
  });

  test("stop from a shared-channel reply can stop the running top-level session", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((_address, sessionKey) => sessionKey === "C1");

    const { bot, client } = await startBot(handler, workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        content: "<@BOT> stop",
        reference: { messageId: "M1" },
      }),
    );
    await bot.stop();

    expect(handler.handleStop).toHaveBeenCalledWith(
      createOfficeAddress("discord", "C1"),
      "C1",
      bot,
      "M1",
    );
  });

  test("logs threadTs for shared channel replies", async () => {
    const { bot, client } = await startBot(makeHandler(), workspace);

    client.deliverMessage(
      makeDiscordMessage({
        id: "M2",
        channelId: "C1",
        reference: { messageId: "M1" },
      }),
    );
    await bot.stop();

    const entry = JSON.parse(requireFirstLine(readOfficeLog(workingDir, "C1")));
    expect(entry.threadTs).toBe("M1");
  });

  test("platform info defaults to hiding usage summary", () => {
    const bot = new DiscordMessagingBot(makeHandler(), {
      token: "TEST_TOKEN",
      workspace,
      client: new FakeDiscordClient(),
    });

    expect(bot.getMessagingInfo().diagnostics?.showUsageSummary).toBe(false);
  });

  test("/session slash command in shared channels replies ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("session link");
    });

    const { bot, client } = await startBot(handler, workspace);
    const interaction = new FakeCommandInteraction({
      id: "I1",
      commandName: "session",
      channelId: "C1",
      inGuild: true,
      channel: guildTextChannel,
    });

    client.deliverInteraction(interaction);
    await bot.stop();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "dm",
      address: { conversationId: "C1" },
      conversationKind: "shared",
      sessionKey: "C1",
      text: "/session",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "session link",
      ephemeral: true,
    });
  });

  test("/session slash command in a Discord thread uses parent channel conversationId", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("session link");
    });

    const { bot, client } = await startBot(handler, workspace);

    client.deliverInteraction(
      new FakeCommandInteraction({
        id: "I2",
        commandName: "session",
        channelId: "THREAD1",
        inGuild: true,
        channel: threadChannel("C1", "thread-topic"),
      }),
    );
    await bot.stop();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C1" },
      sessionKey: "C1:THREAD1",
      thread_ts: "THREAD1",
      text: "/session",
    });
  });

  test("/new slash command resets the resolved session and acknowledges", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);
    const interaction = new FakeCommandInteraction({
      id: "I3",
      commandName: "new",
      channelId: "DM1",
      inGuild: false,
      channel: dmChannel,
    });

    client.deliverInteraction(interaction);
    await bot.stop();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "DM1" },
      conversationKind: "direct",
      sessionKey: "DM1",
      text: "/new",
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test("/new slash command in a guild routes through the command DM gate", async () => {
    const handler = makeHandler();
    const { bot, client } = await startBot(handler, workspace);

    client.deliverInteraction(
      new FakeCommandInteraction({
        id: "I3-GUILD",
        commandName: "new",
        channelId: "C1",
        inGuild: true,
        channel: guildTextChannel,
      }),
    );
    await bot.stop();

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
      (_address, sessionKey) => sessionKey === "C1:THREAD1",
    );
    const { bot, client } = await startBot(handler, workspace);
    const interaction = new FakeCommandInteraction({
      id: "I4",
      commandName: "stop",
      channelId: "THREAD1",
      inGuild: true,
      channel: threadChannel("C1", "thread-topic"),
    });

    client.deliverInteraction(interaction);
    await bot.stop();

    expect(handler.handleStop).toHaveBeenCalledWith(
      createOfficeAddress("discord", "C1"),
      "C1:THREAD1",
      bot,
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Stopped the current conversation.",
      ephemeral: true,
    });
  });
});
