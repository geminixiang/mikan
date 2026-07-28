import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler } from "../src/adapter.js";
import { createOfficeAddress, officeDirName } from "../src/office-address.js";

const C123_OFFICE = officeDirName(createOfficeAddress("slack", "C123"));
import { SlackMessagingBot } from "../src/adapters/slack/bot.js";
import { defaultCommandHandlers } from "../src/commands/registry.js";
import { commandManifestEntry } from "../src/commands/manifest.js";
import { createGlobalSettingsFile } from "../src/config.js";
import type { CommandServices } from "../src/commands/types.js";
import { createConversationRuntime } from "../src/runtime/conversation-runtime.js";
import { createManagedSessionFileAtPath, getThreadSessionFile } from "../src/sessions/store.js";
import type { SandboxConfig } from "../src/sandbox/index.js";
import type { VaultManager } from "../src/vault/index.js";

function makeHandler(): MessagingEventHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
    handleExtensionAction: vi.fn().mockResolvedValue(true),
  };
}

function makeCommandServices(workingDir: string): CommandServices {
  const sandbox: SandboxConfig = { type: "host" };
  return {
    workingDir,
    sandbox,
    vaultManager: {
      hasEntry: () => false,
      resolve: () => undefined,
      list: () => [],
      isEnabled: () => true,
      upsertEnv: () => {},
      upsertFile: () => {},
      listSharedVaults: () => [],
      deleteSharedVault: () => false,
      copySharedVaultTo: () => ({ filesCopied: 0, envKeysCopied: 0 }),
    } as VaultManager,
    linkTokenStore: {
      create: () => ({ token: "tok-link" }),
    },
    sessionViewTokenStore: {
      create: () => ({ token: "tok-session" }),
    },
    adminTokenStore: {
      create: () => ({ token: "tok-admin" }),
    },
  };
}

describe("SlackMessagingBot slash commands", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-bot-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("/pi-login in a shared channel responds ephemerally without opening a DM", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const open = vi.fn().mockResolvedValue({ channel: { id: "D123" } });
    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn().mockResolvedValue({ ts: "2000.0001" });

    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);
    (bot as any).webClient = {
      conversations: { open },
      chat: {
        postEphemeral,
        postMessage,
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashCommand(commandManifestEntry("login").slackRoute, {
      command: "/pi-login",
      text: "github",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(open).not.toHaveBeenCalled();

    const [event, calledMessagingBot, context] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event).toMatchObject({
      type: "private_command",
      conversationId: "C123",
      conversationKind: "shared",
      user: "U123",
      text: "/pi-login github",
      sessionKey: "C123",
    });
    expect(calledMessagingBot).toBe(bot);

    await context.responder.respond("login link");
    expect(postEphemeral).toHaveBeenLastCalledWith({
      channel: "C123",
      user: "U123",
      text: "login link",
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("/pi-new in a DM resets the DM session", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    handler.handleNewCommand = vi.fn(async (_sessionKey, conversationId, commandMessagingBot) => {
      await commandMessagingBot.postMessage(
        conversationId,
        "Conversation reset. Send a new message to start fresh.",
      );
    });

    const postMessage = vi.fn().mockResolvedValue({ ts: "3000.0001" });
    (bot as any).webClient = {
      chat: {
        postMessage,
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashNewCommand({
      command: "/pi-new",
      channel_id: "D123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleNewCommand).toHaveBeenCalledWith(
      "D123",
      "D123",
      expect.any(Object),
      expect.objectContaining({ sessionKey: "D123", userId: "U123" }),
      expect.any(Object),
      expect.objectContaining({ name: "slack" }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      channel: "D123",
      text: "Conversation reset. Send a new message to start fresh.",
      blocks: [
        { type: "markdown", text: "Conversation reset. Send a new message to start fresh." },
      ],
    });
  });

  test("/pi-new in a shared channel is rejected with an ephemeral hint", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0002" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashNewCommand({
      command: "/pi-new",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleNewCommand).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "為了避免誤清除共享上下文，/pi-new 目前只能在與 mikan 的私訊中使用。",
    });
  });

  test("/pi-sandbox in a shared channel routes to command handling ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("sandbox status");
    });

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0003" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);

    await (bot as any).handleSlashCommand({
      body: {
        command: "/pi-sandbox",
        text: "boost",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: vi.fn().mockResolvedValue(undefined),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "mention",
      conversationId: "C123",
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-sandbox boost",
    });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "sandbox status",
    });
  });

  test("/pi-auto-reply in a shared channel routes to command handling ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("auto reply status");
    });

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0004" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);

    await (bot as any).handleSlashCommand({
      body: {
        command: "/pi-auto-reply",
        text: "on",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: vi.fn().mockResolvedValue(undefined),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "mention",
      conversationId: "C123",
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-auto-reply on",
    });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "auto reply status",
    });
  });

  test("/pi-auto-reply in a shared channel is accepted by the command handler", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const runtime = createConversationRuntime({
      ...makeCommandServices(workingDir),
      commandHandlers: defaultCommandHandlers(),
    });
    (handler.handleEvent as any).mockImplementation(
      (event: any, eventMessagingBot: any, context: any) =>
        runtime.runSession({ event, bot: eventMessagingBot, context }),
    );

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0005" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);

    await (bot as any).handleSlashCommand({
      body: {
        command: "/pi-auto-reply",
        text: "on",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: vi.fn().mockResolvedValue(undefined),
    });

    // handleSlashCommand fires handlerPromise without awaiting it (fast-ack design);
    // wait until the handler has actually finished before asserting.
    await vi.waitFor(() =>
      expect(postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: expect.stringContaining("Auto-reply is enabled"),
        }),
      ),
    );
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Edit rules at:"),
      }),
    );
    expect(postEphemeral).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("只能在 group/channel"),
      }),
    );
    expect(readFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "utf-8")).toBe("");
    expect(existsSync(join(workingDir, C123_OFFICE, "settings.json"))).toBe(false);
  });

  test("/pi-session in a shared channel returns the link ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("session link");
    });

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0002" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);

    await (bot as any).routeSlashCommand(commandManifestEntry("session").slackRoute, {
      command: "/pi-session",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "mention",
      conversationId: "C123",
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-session",
    });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "session link",
    });
  });

  test("/pi-session in a shared channel thread returns the link ephemerally in that thread", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("thread session link");
    });

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    (bot as any).webClient = {
      chat: {
        postEphemeral,
        postMessage: vi.fn().mockResolvedValue({ ts: "3000.0002" }),
        update: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };

    await (bot as any).routeSlashCommand(commandManifestEntry("session").slackRoute, {
      command: "/pi-session",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
      thread_ts: "1000.0001",
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      conversationKind: "shared",
      sessionKey: "C123:1000.0001",
      thread_ts: "1000.0001",
      text: "/pi-session",
    });
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "thread session link",
      thread_ts: "1000.0001",
    });
  });
});

describe("SlackMessagingBot queues follow-up messages", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-queue-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("shared channel mentions are queued while the session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "C123",
    );

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("2000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123");
    queue.processing = true;
    const ack = vi.fn();

    mentionHandler?.({
      event: {
        text: "<@B123> second request",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).postMessage).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      sessionKey: "C123",
      text: "second request",
    });
  });

  test("shared channel auto-reply candidates queue when auto-reply is enabled", async () => {
    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "");

    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "deployment failed",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "channel",
      },
      ack,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      sessionKey: "C123",
      text: "deployment failed",
    });
  });

  test("shared channel auto-reply candidates only log when auto-reply is disabled", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "deployment failed",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "channel",
      },
      ack,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ack).toHaveBeenCalled();
    expect((bot as any).getQueue("C123").size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM stop is handled immediately and bypasses the intake queue", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "D123",
    );
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "stop",
        channel: "D123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(handler.handleStop).toHaveBeenCalledWith(
      createOfficeAddress("slack", "D123"),
      "D123",
      bot,
    );
    expect((bot as any).getQueue("D123").size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("bare shared channel stop does not trigger auto-reply", async () => {
    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "");

    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("2000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "stop",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(handler.handleStop).not.toHaveBeenCalled();
    expect((bot as any).postMessage).not.toHaveBeenCalled();
    expect((bot as any).getQueue("C123").size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("bare shared channel mentions ask the agent to use recent context", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    mentionHandler?.({
      event: {
        text: "<@B123>",
        channel: "C123",
        user: "U123",
        ts: "1001.00015",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();

    const queue = (bot as any).getQueue("C123");
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      text: "Please respond to the recent conversation context.",
    });
  });

  test("shared channel mentions preserve mentions of other users", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    mentionHandler?.({
      event: {
        text: "<@B123> ask <@U999> about this",
        channel: "C123",
        user: "U123",
        ts: "1001.00015",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();

    const queue = (bot as any).getQueue("C123");
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      text: "ask <@U999> about this",
    });
  });

  test("first shared-channel thread reply waits behind the channel queue until the thread session exists", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            thread_ts?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("2000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123");
    queue.processing = true;
    const ack = vi.fn();

    mentionHandler?.({
      event: {
        text: "<@B123> thread request",
        channel: "C123",
        user: "U123",
        ts: "1001.0002",
        thread_ts: "1000.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies do not trigger after the thread session exists", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const conversationDir = join(workingDir, C123_OFFICE);
    createManagedSessionFileAtPath(join(conversationDir, "session.jsonl"), conversationDir);
    createManagedSessionFileAtPath(
      getThreadSessionFile(conversationDir, "C123:1000.0001"),
      conversationDir,
    );

    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "1001.0003",
        thread_ts: "1000.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).getQueue("C123:1000.0001").size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("Slack events create a top-level anchor and run under that thread session", async () => {
    const handler = makeHandler();
    const handled = new Promise<void>((resolve, reject) => {
      handler.handleEvent = vi.fn(async (event, _calledMessagingBot, context) => {
        try {
          expect(event).toMatchObject({
            conversationId: "C123",
            sessionKey: "C123:2000.0001",
            ts: "event:deploy-reminder",
          });
          expect(context.message.sessionKey).toBe("C123:2000.0001");
          await context.responder.respond("event done");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    (bot as any).postMessage = vi.fn().mockResolvedValue("2000.0001");
    (bot as any).updateMessage = vi.fn().mockResolvedValue(undefined);

    expect(
      bot.enqueueEvent({
        type: "mention",
        address: createOfficeAddress("slack", "C123"),
        conversationId: "C123",
        conversationKind: "shared",
        ts: "event:deploy-reminder",
        user: "EVENT",
        text: "Deploy in 10 minutes",
      }),
    ).toBe(true);

    await Promise.race([
      handled,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("Slack event was not handled")), 1000);
      }),
    ]);

    expect((bot as any).postMessage).toHaveBeenCalledTimes(1);
    expect((bot as any).postMessage).toHaveBeenCalledWith("C123", "Working on it...");
    expect((bot as any).updateMessage).toHaveBeenCalledWith(
      "C123",
      "2000.0001",
      expect.stringContaining("event done"),
    );
    expect(existsSync(getThreadSessionFile(join(workingDir, C123_OFFICE), "C123:2000.0001"))).toBe(
      true,
    );
  });

  test("postInThread wraps text in a markdown block", async () => {
    const bot = new SlackMessagingBot(makeHandler(), {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });
    const postMessage = vi.fn().mockResolvedValue({ ts: "2000.0001" });
    (bot as any).webClient = { chat: { postMessage } };

    await bot.postInThread("C123", "1000.0001", "x".repeat(600));

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1000.0001",
      text: "x".repeat(600),
      blocks: [{ type: "markdown", text: "x".repeat(600) }],
    });
  });

  test("Slack events report anchor failures instead of creating legacy event sessions", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const postMessage = vi.fn().mockRejectedValueOnce(new Error("anchor failed"));
    (bot as any).postMessage = postMessage;
    (bot as any).updateMessage = vi.fn().mockResolvedValue(undefined);

    expect(
      bot.enqueueEvent({
        type: "mention",
        address: createOfficeAddress("slack", "C123"),
        conversationId: "C123",
        conversationKind: "shared",
        ts: "event:deploy-reminder",
        user: "EVENT",
        text: "Deploy in 10 minutes",
      }),
    ).toBe(true);

    for (let i = 0; i < 10 && postMessage.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(postMessage).toHaveBeenNthCalledWith(1, "C123", "Working on it...");
    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect((bot as any).updateMessage).not.toHaveBeenCalled();
    expect(existsSync(join(workingDir, "C123", "sessions"))).toBe(false);
  });

  test("Slack event anchor thread replies queue behind the event anchor run", async () => {
    const handler = makeHandler();
    let releaseEventRun!: () => void;
    const eventRunCanFinish = new Promise<void>((resolve) => {
      releaseEventRun = resolve;
    });
    let resolveEventHandled!: () => void;
    let rejectEventHandled!: (err: unknown) => void;
    const eventHandled = new Promise<void>((resolve, reject) => {
      resolveEventHandled = resolve;
      rejectEventHandled = reject;
    });
    handler.handleEvent = vi.fn(async (event, _calledMessagingBot, context) => {
      try {
        expect(event).toMatchObject({
          conversationId: "C123",
          sessionKey: "C123:2000.0001",
        });
        expect(context.message.sessionKey).toBe("C123:2000.0001");
        resolveEventHandled();
        await eventRunCanFinish;
      } catch (err) {
        rejectEventHandled(err);
      }
    });

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    (bot as any).postMessage = vi.fn().mockResolvedValue("2000.0001");
    (bot as any).updateMessage = vi.fn().mockResolvedValue(undefined);

    expect(
      bot.enqueueEvent({
        type: "mention",
        address: createOfficeAddress("slack", "C123"),
        conversationId: "C123",
        conversationKind: "shared",
        ts: "event:deploy-reminder",
        user: "EVENT",
        text: "Deploy in 10 minutes",
      }),
    ).toBe(true);

    await Promise.race([
      eventHandled,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("Slack event was not handled")), 1000);
      }),
    ]);

    expect((bot as any).resolveQueueKey("C123", "C123:2000.0001")).toBe("C123:2000.0001");

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };
    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123:2000.0001");
    expect(queue.processing).toBe(true);
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "2001.0001",
        thread_ts: "2000.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(0);
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    releaseEventRun();
    await eventHandled;

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("external Slack app bot messages are logged but do not trigger mikan", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            subtype?: string;
            bot_id?: string;
            app_id?: string;
            username?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "U_MIKAN";
    (bot as any).botId = "B_MIKAN";
    (bot as any).logExternalMessagingBotMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();
    messageHandler?.({
      event: {
        text: "Test Issue\nProject: pi-agent",
        channel: "C123",
        ts: "1001.0003",
        subtype: "bot_message",
        bot_id: "B_SENTRY",
        app_id: "A_SENTRY",
        username: "Sentry",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).logExternalMessagingBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bot_id: "B_SENTRY", username: "Sentry" }),
    );
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies do not trigger for unrelated threads", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "unrelated thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "1001.0003",
        thread_ts: "1000.0009",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).getQueue("C123").size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies do not trigger while that thread session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "C123:1000.0001",
    );

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockResolvedValue([]);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("C123:1000.0001");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread follow-up",
        channel: "C123",
        user: "U123",
        ts: "1001.0003",
        thread_ts: "1000.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(0);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM follow-up messages are queued while the top-level DM session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "D123",
    );

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D123");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "second request",
        channel: "D123",
        user: "U123",
        ts: "2001.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).postMessage).not.toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "D123",
      sessionKey: "D123",
      text: "second request",
    });
  });

  test("first DM thread reply waits behind the top-level DM queue until the thread session exists", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D123");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread request",
        channel: "D123",
        user: "U123",
        ts: "2001.0001",
        thread_ts: "2000.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM message without channel_type still routes as a direct message", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D999");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "dm without channel_type",
        channel: "D999",
        user: "U123",
        ts: "2001.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "D999",
      conversationKind: "direct",
      sessionKey: "D999",
      text: "dm without channel_type",
    });
  });

  test("DM posted via a user token (human user plus bot_id) routes as a user message", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            channel_type?: string;
            bot_id?: string;
            app_id?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).users.set("UHUMAN", {
      id: "UHUMAN",
      userName: "qa-human",
      displayName: "QA Human",
      isBot: false,
    });
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D999");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "dm posted with a user token",
        channel: "D999",
        user: "UHUMAN",
        ts: "2001.0001",
        channel_type: "im",
        bot_id: "BPOSTINGAPP",
        app_id: "APOSTINGAPP",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "D999",
      user: "UHUMAN",
      text: "dm posted with a user token",
    });
  });

  test("DM from a bot user keeps the external-bot ignore path", async () => {
    const handler = makeHandler();

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            channel_type?: string;
            bot_id?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).users.set("UOTHERBOT", {
      id: "UOTHERBOT",
      userName: "other-bot",
      displayName: "Other Bot",
      isBot: true,
    });
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).logExternalMessagingBotMessage = vi.fn().mockResolvedValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    (bot as any).setupEventHandlers();
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "bot dm",
        channel: "D999",
        user: "UOTHERBOT",
        ts: "2001.0001",
        channel_type: "im",
        bot_id: "BOTHERBOT",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect((bot as any).logExternalMessagingBotMessage).toHaveBeenCalledTimes(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect((bot as any).getQueue("D999").size()).toBe(0);
  });

  test("DM thread follow-up messages are queued on the thread session key once the thread session exists", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "D123:2000.0001",
    );

    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let messageHandler:
      | ((payload: {
          event: {
            text?: string;
            channel: string;
            user?: string;
            ts: string;
            thread_ts?: string;
            channel_type?: string;
          };
          ack: () => void;
        }) => void)
      | undefined;

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue([]);
    (bot as any).postMessage = vi.fn().mockResolvedValue("3000.0001");
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "message") messageHandler = fn as typeof messageHandler;
      }),
    };

    createManagedSessionFileAtPath(
      getThreadSessionFile(join(workingDir, "D123"), "D123:2000.0001"),
      join(workingDir, "D123"),
    );

    (bot as any).setupEventHandlers();

    const queue = (bot as any).getQueue("D123:2000.0001");
    queue.processing = true;
    const ack = vi.fn();

    messageHandler?.({
      event: {
        text: "thread request",
        channel: "D123",
        user: "U123",
        ts: "2001.0001",
        thread_ts: "2000.0001",
        channel_type: "im",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "D123",
      sessionKey: "D123:2000.0001",
      text: "thread request",
      thread_ts: "2000.0001",
    });
  });
});

describe("SlackMessagingBot backfill", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-backfill-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("backfill preserves threadTs for thread replies", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {
        processAttachments: vi.fn().mockResolvedValue([]),
      } as any,
    });

    (bot as any).botUserId = "B123";
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);
    (bot as any).webClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              user: "U123",
              text: "reply in thread",
              ts: "1000.0002",
              thread_ts: "1000.0001",
            },
          ],
          response_metadata: {},
        }),
      },
    };

    const count = await (bot as any).backfillChannel("C123");

    expect(count).toBe(1);
    const logContent = readFileSync(
      join(workingDir, officeDirName(createOfficeAddress("slack", "C123")), "log.jsonl"),
      "utf-8",
    );
    expect(logContent).toContain('"threadTs":"1000.0001"');
  });

  test("backfill logs external app bot messages", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {
        processAttachments: vi.fn().mockResolvedValue([]),
      } as any,
    });

    (bot as any).botUserId = "U_MIKAN";
    (bot as any).botId = "B_MIKAN";
    (bot as any).webClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              bot_id: "B_SENTRY",
              app_id: "A_SENTRY",
              username: "Sentry",
              subtype: "bot_message",
              text: "[pi-agent] Test Issue",
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: "*Test Issue*\npoll(.../sentry/scripts/views.js)" },
                },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: "*State:* New" },
                    { type: "mrkdwn", text: "*Short ID:* PI-AGENT-A" },
                  ],
                },
              ],
              ts: "1000.0002",
            },
          ],
          response_metadata: {},
        }),
      },
    };

    const count = await (bot as any).backfillChannel("C123");

    expect(count).toBe(1);
    const logContent = readFileSync(
      join(workingDir, officeDirName(createOfficeAddress("slack", "C123")), "log.jsonl"),
      "utf-8",
    );
    expect(logContent).toContain('"userName":"Sentry"');
    expect(logContent).toContain("[pi-agent] Test Issue");
    expect(logContent).toContain("poll(.../sentry/scripts/views.js)");
    expect(logContent).toContain("PI-AGENT-A");
    expect(logContent).toContain('"botId":"B_SENTRY"');
  });

  test("backfill preserves mentions of other users while stripping mikan", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {
        processAttachments: vi.fn().mockResolvedValue([]),
      } as any,
    });

    (bot as any).botUserId = "B123";
    (bot as any).users = new Map([
      ["U123", { id: "U123", userName: "alice", displayName: "Alice" }],
    ]);
    (bot as any).webClient = {
      conversations: {
        history: vi.fn().mockResolvedValue({
          messages: [
            {
              user: "U123",
              text: "<@B123> ask <@U999> about this",
              ts: "1000.0002",
            },
          ],
          response_metadata: {},
        }),
      },
    };

    const count = await (bot as any).backfillChannel("C123");

    expect(count).toBe(1);
    const logContent = readFileSync(
      join(workingDir, officeDirName(createOfficeAddress("slack", "C123")), "log.jsonl"),
      "utf-8",
    );
    expect(logContent).toContain('"text":"ask <@U999> about this"');
  });
});

describe("SlackMessagingBot attachments", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-attachments-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("waits for attachment downloads before invoking the agent", async () => {
    const handler = makeHandler();
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    let mentionHandler:
      | ((payload: {
          event: {
            text: string;
            channel: string;
            user: string;
            ts: string;
            files?: Array<{ name: string; url_private: string }>;
          };
          ack: () => void;
        }) => void)
      | undefined;

    let resolveAttachments!: (attachments: Array<{ original: string; localPath: string }>) => void;
    const attachmentsPromise = new Promise<Array<{ original: string; localPath: string }>>(
      (resolve) => {
        resolveAttachments = resolve;
      },
    );

    (bot as any).startupTs = "0";
    (bot as any).botUserId = "B123";
    (bot as any).logUserMessage = vi.fn().mockReturnValue(attachmentsPromise);
    (bot as any).socketClient = {
      on: vi.fn((event: string, fn: unknown) => {
        if (event === "app_mention") mentionHandler = fn as typeof mentionHandler;
      }),
    };

    (bot as any).setupEventHandlers();

    const ack = vi.fn();
    mentionHandler?.({
      event: {
        text: "<@B123> 看這個檔案",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        files: [{ name: "clip.mov", url_private: "https://example.com/clip.mov" }],
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    await Promise.resolve();
    expect(handler.handleEvent).not.toHaveBeenCalled();

    resolveAttachments([{ original: "clip.mov", localPath: "C123/attachments/1_clip.mov" }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ original: "clip.mov", localPath: "C123/attachments/1_clip.mov" }],
    });
  });
});

describe("SlackMessagingBot force-stop block action", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-forcestop-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  function makeForceStopBot(handler: MessagingEventHandler) {
    const bot = new SlackMessagingBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });
    (bot as any).webClient = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ts: "9000.0001" }) },
      views: { publish: vi.fn().mockResolvedValue(undefined) },
    };
    return bot;
  }

  test("session keys with underscored conversation ids survive via the button value", async () => {
    const handler = makeHandler();
    const bot = makeForceStopBot(handler);
    const sessionKey = "GH_owner_repo_42:1000.0001";

    await (bot as any).handleBlockAction({
      body: {
        actions: [
          {
            // action_id carries the (lossy) sanitized copy; value is authoritative.
            action_id: `force_stop_${sessionKey.replace(/:/g, "_")}`,
            value: sessionKey,
          },
        ],
        user: { id: "U123" },
        container: {},
      },
      ack: vi.fn(),
    });

    expect(handler.forceStop).toHaveBeenCalledWith(
      createOfficeAddress("slack", "GH_owner_repo_42"),
      sessionKey,
    );
  });

  test("legacy buttons without a value fall back to action_id decoding", async () => {
    const handler = makeHandler();
    const bot = makeForceStopBot(handler);

    await (bot as any).handleBlockAction({
      body: {
        actions: [{ action_id: "force_stop_C123_1000.0001" }],
        user: { id: "U123" },
        container: { channel_id: "C123" },
      },
      ack: vi.fn(),
    });

    expect(handler.forceStop).toHaveBeenCalledWith(
      createOfficeAddress("slack", "C123"),
      "C123:1000.0001",
    );
  });

  test("ext-namespaced actions dispatch to the extension handler, never the agent", async () => {
    const handler = makeHandler();
    const bot = makeForceStopBot(handler);

    await (bot as any).handleBlockAction({
      body: {
        actions: [{ action_id: "ext:poll:vote_1", value: "1" }],
        user: { id: "U123", username: "alice" },
        container: { channel_id: "C123", message_ts: "100.1" },
      },
      ack: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler.handleExtensionAction).toHaveBeenCalledWith({
      address: createOfficeAddress("slack", "C123"),
      sessionKey: "C123",
      conversationKind: "shared",
      slug: "poll",
      action: {
        actionId: "vote_1",
        value: "1",
        selectedValues: undefined,
        userId: "U123",
        userName: "alice",
        conversationId: "C123",
        messageTs: "100.1",
        threadTs: undefined,
      },
    });
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("unconsumed ext actions are dropped, not routed to the agent", async () => {
    const handler = makeHandler();
    (handler.handleExtensionAction as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const bot = makeForceStopBot(handler);

    await (bot as any).handleBlockAction({
      body: {
        actions: [{ action_id: "ext:gone:click", value: "x" }],
        user: { id: "U123" },
        container: { channel_id: "C123" },
      },
      ack: vi.fn(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler.handleExtensionAction).toHaveBeenCalled();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });
});
