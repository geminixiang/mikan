import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BotHandler } from "../src/adapter.js";
import { SlackBot } from "../src/adapters/slack/bot.js";
import { defaultCommandHandlers } from "../src/commands/index.js";
import type { CommandServices } from "../src/commands/types.js";
import { ConversationOrchestrator } from "../src/runtime/conversation-orchestrator.js";
import { createManagedSessionFileAtPath, getThreadSessionFile } from "../src/sessions/store.js";
import type { SandboxConfig } from "../src/sandbox/index.js";
import type { VaultManager } from "../src/vault.js";

function makeHandler(): BotHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
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
      getSandboxConfig: (_uid, base) => base,
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
  };
}

describe("SlackBot slash commands", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-slack-bot-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("/pi-login in a shared channel responds ephemerally without opening a DM", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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

    await (bot as any).routeSlashLoginCommand({
      command: "/pi-login",
      text: "github",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(open).not.toHaveBeenCalled();

    const [event, calledBot, adapters] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event).toMatchObject({
      type: "private_command",
      conversationId: "C123",
      conversationKind: "shared",
      user: "U123",
      text: "/pi-login github",
      sessionKey: "C123",
    });
    expect(calledBot).toBe(bot);

    await adapters.responseCtx.respond("login link");
    expect(postEphemeral).toHaveBeenLastCalledWith({
      channel: "C123",
      user: "U123",
      text: "login link",
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  test("/pi-new in a DM resets the DM session", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    handler.handleNewCommand = vi.fn(async (_sessionKey, conversationId, commandBot) => {
      await commandBot.postMessage(
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

    expect(handler.handleNewCommand).toHaveBeenCalledWith("D123", "D123", expect.any(Object));
    expect(postMessage).toHaveBeenCalledWith({
      channel: "D123",
      text: "Conversation reset. Send a new message to start fresh.",
    });
  });

  test("/pi-new in a shared channel is rejected with an ephemeral hint", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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
    handler.handleEvent = vi.fn(async (_event, _bot, adapters) => {
      await adapters.responseCtx.respond("sandbox status");
    });

    const bot = new SlackBot(handler, {
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

    await (bot as any).routeSlashSandboxCommand({
      command: "/pi-sandbox",
      text: "boost",
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
    handler.handleEvent = vi.fn(async (_event, _bot, adapters) => {
      await adapters.responseCtx.respond("auto reply status");
    });

    const bot = new SlackBot(handler, {
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

    await (bot as any).routeSlashAutoReplyCommand({
      command: "/pi-auto-reply",
      text: "on",
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
    const bot = new SlackBot(handler, {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      workingDir,
      store: {} as any,
    });

    const orchestrator = new ConversationOrchestrator({
      workingDir,
      commandHandlers: defaultCommandHandlers(),
      commandServices: makeCommandServices(workingDir),
      isShuttingDown: () => false,
      getState: () => undefined,
      getOrCreateState: vi.fn(),
      beforeRunTracked: vi.fn(),
      afterRunTracked: vi.fn(),
      onRunFinished: vi.fn(),
    });
    (handler.handleEvent as any).mockImplementation((event: any, eventBot: any, adapters: any) =>
      orchestrator.runSession({ event, bot: eventBot, adapters }),
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

    await (bot as any).routeSlashAutoReplyCommand({
      command: "/pi-auto-reply",
      text: "on",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
    });

    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        user: "U123",
        text: expect.stringContaining("Auto-reply is enabled"),
      }),
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
    expect(readFileSync(join(workingDir, "C123", "auto-reply"), "utf-8")).toBe("");
    expect(existsSync(join(workingDir, "C123", "settings.json"))).toBe(false);
  });

  test("/pi-session in a shared channel returns the link ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, adapters) => {
      await adapters.responseCtx.respond("session link");
    });

    const bot = new SlackBot(handler, {
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

    await (bot as any).routeSlashSessionCommand({
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
    handler.handleEvent = vi.fn(async (_event, _bot, adapters) => {
      await adapters.responseCtx.respond("thread session link");
    });

    const bot = new SlackBot(handler, {
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

    await (bot as any).routeSlashSessionCommand({
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

describe("SlackBot queues follow-up messages", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-slack-queue-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("shared channel mentions are queued while the session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((sessionKey: string) => sessionKey === "C123");

    const bot = new SlackBot(handler, {
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

  test("shared channel mentions preserve mentions of other users", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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

    const bot = new SlackBot(handler, {
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

  test("shared-channel bare thread replies trigger without a mention after the thread session exists", async () => {
    const handler = makeHandler();

    const bot = new SlackBot(handler, {
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

    const conversationDir = join(workingDir, "C123");
    createManagedSessionFileAtPath(join(conversationDir, "session.jsonl"), conversationDir);
    createManagedSessionFileAtPath(
      getThreadSessionFile(conversationDir, "C123:1000.0001"),
      conversationDir,
    );

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
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    queue.processing = false;
    await queue.processNext();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      conversationId: "C123",
      sessionKey: "C123:1000.0001",
      text: "thread follow-up",
      thread_ts: "1000.0001",
    });
  });

  test("Slack events create a top-level anchor and run under that fork session", async () => {
    const handler = makeHandler();
    const handled = new Promise<void>((resolve, reject) => {
      handler.handleEvent = vi.fn(async (event, _calledBot, adapters) => {
        try {
          expect(event).toMatchObject({
            conversationId: "C123",
            sessionKey: "C123:2000.0001",
            ts: "event:deploy-reminder",
          });
          expect(adapters.message.sessionKey).toBe("C123:2000.0001");
          await adapters.responseCtx.respond("event done");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });

    const bot = new SlackBot(handler, {
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
    expect(existsSync(getThreadSessionFile(join(workingDir, "C123"), "C123:2000.0001"))).toBe(true);
  });

  test("Slack events report anchor failures instead of creating legacy event sessions", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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

  test("Slack event anchor thread replies queue behind the event fork run", async () => {
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
    const replyHandled = new Promise<void>((resolve, reject) => {
      handler.handleEvent = vi.fn(async (event, _calledBot, adapters) => {
        try {
          if (event.ts === "event:deploy-reminder") {
            expect(event).toMatchObject({
              conversationId: "C123",
              sessionKey: "C123:2000.0001",
            });
            expect(adapters.message.sessionKey).toBe("C123:2000.0001");
            resolveEventHandled();
            await eventRunCanFinish;
            return;
          }
          expect(event).toMatchObject({
            conversationId: "C123",
            sessionKey: "C123:2000.0001",
            text: "thread follow-up",
            thread_ts: "2000.0001",
          });
          resolve();
        } catch (err) {
          if (event.ts === "event:deploy-reminder") rejectEventHandled(err);
          else reject(err);
        }
      });
    });

    const bot = new SlackBot(handler, {
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

    expect((bot as any).shouldTriggerSharedThreadReply("C123", "2000.0001")).toBe(true);
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
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    releaseEventRun();
    await replyHandled;

    expect(handler.handleEvent).toHaveBeenCalledTimes(2);
  });

  test("external Slack app bot messages are logged but do not trigger mikan", async () => {
    const handler = makeHandler();

    const bot = new SlackBot(handler, {
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
    (bot as any).logExternalBotMessage = vi.fn().mockResolvedValue([]);
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
    expect((bot as any).logExternalBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({ bot_id: "B_SENTRY", username: "Sentry" }),
    );
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies do not trigger for unrelated threads", async () => {
    const handler = makeHandler();

    const bot = new SlackBot(handler, {
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

  test("shared-channel bare thread replies still trigger while that thread session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (sessionKey: string) => sessionKey === "C123:1000.0001",
    );

    const bot = new SlackBot(handler, {
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
    expect(queue.size()).toBe(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM follow-up messages are queued while the top-level DM session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation((sessionKey: string) => sessionKey === "D123");

    const bot = new SlackBot(handler, {
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

    const bot = new SlackBot(handler, {
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

  test("DM thread follow-up messages are queued on the thread session key once the thread session exists", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (sessionKey: string) => sessionKey === "D123:2000.0001",
    );

    const bot = new SlackBot(handler, {
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

describe("SlackBot backfill", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-slack-backfill-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("backfill preserves threadTs for thread replies", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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
    const logContent = readFileSync(join(workingDir, "C123", "log.jsonl"), "utf-8");
    expect(logContent).toContain('"threadTs":"1000.0001"');
  });

  test("backfill logs external app bot messages", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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
    const logContent = readFileSync(join(workingDir, "C123", "log.jsonl"), "utf-8");
    expect(logContent).toContain('"userName":"Sentry"');
    expect(logContent).toContain("[pi-agent] Test Issue");
    expect(logContent).toContain("poll(.../sentry/scripts/views.js)");
    expect(logContent).toContain("PI-AGENT-A");
    expect(logContent).toContain('"botId":"B_SENTRY"');
  });

  test("backfill preserves mentions of other users while stripping mikan", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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
    const logContent = readFileSync(join(workingDir, "C123", "log.jsonl"), "utf-8");
    expect(logContent).toContain('"text":"ask <@U999> about this"');
  });
});

describe("SlackBot attachments", () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-slack-attachments-${Date.now()}`);
    mkdirSync(workingDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("waits for attachment downloads before invoking the agent", async () => {
    const handler = makeHandler();
    const bot = new SlackBot(handler, {
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
