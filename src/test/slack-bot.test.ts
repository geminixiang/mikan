import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnownBlock } from "@slack/types";
import type {
  ConversationsHistoryResponse,
  ConversationsListResponse,
  FetchFunction,
  UsersListResponse,
} from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const evaluateWithJevMock = vi.fn();
vi.mock("../harness/jev.js", async () => {
  const actual = await vi.importActual<typeof import("../harness/jev.js")>("../harness/jev.js");
  return { ...actual, evaluateWithJev: (...args: unknown[]) => evaluateWithJevMock(...args) };
});
import type { MessagingEventHandler } from "../types.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import type { Workspace } from "../office/types.js";

const C123_OFFICE = officeKey(createOfficeAddress("slack", "C123"));
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import type {
  SlackSocketConnection,
  SlackSocketEventArgs,
  SlackWebApi,
} from "../adapters/slack/types.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import { readPlatformChannelKind } from "../office/projection.js";
import { createManagedSessionFileAtPath, getThreadSessionFile } from "../sessions/store.js";
import { isRecord } from "../unknown-values.js";

type SlackMember = NonNullable<UsersListResponse["members"]>[number];
type SlackConversation = NonNullable<ConversationsListResponse["channels"]>[number];
type FetchInit = Parameters<FetchFunction>[1];
type HistoryBlocks = NonNullable<
  NonNullable<ConversationsHistoryResponse["messages"]>[number]["blocks"]
>;

function sdkHistoryBlocks(blocks: KnownBlock[]): HistoryBlocks {
  return blocks as HistoryBlocks;
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

class FakeSlackSocket implements SlackSocketConnection {
  private readonly listeners = new Map<string, Array<(args: SlackSocketEventArgs) => unknown>>();

  on(event: string, listener: (args: SlackSocketEventArgs) => unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  async start(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async deliver(event: string, args: SlackSocketEventArgs): Promise<void> {
    await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(args)));
  }
}

function makeAck() {
  return vi.fn(async () => {});
}

function createFakeWebApi(): SlackWebApi {
  return {
    auth: { test: vi.fn(async () => ({ ok: true, user_id: "B123" })) },
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: "2000.0001" })),
      postEphemeral: vi.fn(async () => ({ ok: true })),
      update: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true })),
    },
    conversations: {
      open: vi.fn(async () => ({ ok: true, channel: { id: "D123" } })),
      history: vi.fn(async () => ({ ok: true, messages: [] })),
      replies: vi.fn(async () => ({ ok: true, messages: [] })),
      list: vi.fn(async () => ({ ok: true, channels: [] })),
    },
    users: { list: vi.fn(async () => ({ ok: true, members: [] })) },
    reactions: { add: vi.fn(async () => ({ ok: true })) },
    views: { publish: vi.fn(async () => ({ ok: true })) },
    files: { uploadV2: vi.fn(async () => ({ ok: true, files: [] })) },
    assistant: {
      threads: {
        setSuggestedPrompts: vi.fn(async () => ({ ok: true })),
        setTitle: vi.fn(async () => ({ ok: true })),
      },
    },
    apiCall: vi.fn(async () => ({ ok: true })),
  };
}

interface SlackHarnessOptions {
  handler: MessagingEventHandler;
  workspace: Workspace;
  auth?: { user_id: string; bot_id?: string };
  members?: SlackMember[];
  channels?: SlackConversation[];
  fetch?: FetchFunction;
}

interface SlackHarness {
  bot: SlackMessagingBot;
  web: SlackWebApi;
  socket: FakeSlackSocket;
}

function createSlackHarness(options: SlackHarnessOptions): SlackHarness {
  const web = createFakeWebApi();
  vi.mocked(web.auth.test).mockResolvedValue({
    ok: true,
    ...(options.auth ?? { user_id: "B123" }),
  });
  vi.mocked(web.users.list).mockResolvedValue({ ok: true, members: options.members ?? [] });
  vi.mocked(web.conversations.list).mockImplementation(async (args) => ({
    ok: true,
    channels: args?.types === "im" ? [] : (options.channels ?? []),
  }));
  const socket = new FakeSlackSocket();
  const bot = new SlackMessagingBot(options.handler, {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    workspace: options.workspace,
    webApi: web,
    socket,
    fetch: options.fetch,
  });
  return { bot, web, socket };
}

async function startSlackHarness(options: SlackHarnessOptions): Promise<SlackHarness> {
  const harness = createSlackHarness(options);
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  try {
    await harness.bot.start();
  } finally {
    now.mockRestore();
  }
  return harness;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function readLogEntries(workspace: Workspace, channel: string): Array<Record<string, unknown>> {
  const { logPath } = workspace.office(createOfficeAddress("slack", channel));
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord);
}

function slackResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function apiMethod(url: string | URL): string {
  return String(url).split("/").pop() ?? "";
}

function formBody(init: FetchInit): URLSearchParams {
  return new URLSearchParams(typeof init?.body === "string" ? init.body : "");
}

describe("Slack channel kind backfill", () => {
  test("records kinds for registered offices from the loaded channel list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-kind-backfill-"));
    try {
      const workspace = createWorkspace({ root: join(dir, "ws"), stateDir: join(dir, "state") });
      mkdirSync(workspace.root, { recursive: true });
      const publicOffice = workspace.office(createOfficeAddress("slack", "CPUB"));
      const privateOffice = workspace.office(createOfficeAddress("slack", "CPRIV"));
      const dm = workspace.office(createOfficeAddress("slack", "D1"));
      const unknown = workspace.office(createOfficeAddress("slack", "CGONE"));
      for (const office of [publicOffice, privateOffice, dm, unknown]) office.ensure();

      const { bot } = await startSlackHarness({
        handler: makeHandler(),
        workspace,
        channels: [
          { id: "CPUB", name: "pub", is_member: true, is_private: false },
          { id: "CPRIV", name: "priv", is_member: true, is_private: true },
        ],
      });
      await bot.stop();

      expect(readPlatformChannelKind(publicOffice)).toBe("public_channel");
      expect(readPlatformChannelKind(privateOffice)).toBe("private_channel");
      expect(readPlatformChannelKind(dm)).toBe("im");
      expect(readPlatformChannelKind(unknown)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Slack status transport", () => {
  test("status timeout uses an abort signal, rejects once, and releases its queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-status-"));
    try {
      const abort = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
      const fetch = vi.fn<FetchFunction>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const bot = new SlackMessagingBot(makeHandler(), {
        appToken: "test",
        botToken: "test",
        workspace: createWorkspace({ root: dir, stateDir: dir }),
        fetch,
      });
      try {
        const result = bot.setAssistantStatus("C1", "1", "Thinking");
        const rejected = expect(result).rejects.toThrow();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        expect(timeout).toHaveBeenCalledWith(3000);
        abort.abort(new Error("test timeout"));
        await rejected;
        expect(fetch).toHaveBeenCalledTimes(1);

        timeout.mockReturnValue(new AbortController().signal);
        fetch.mockResolvedValueOnce(slackResponse({ ok: true }));
        await bot.setAssistantStatus("C1", "1", "");
        expect(fetch).toHaveBeenCalledTimes(2);
      } finally {
        timeout.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes late Thinking and clear across callers without blocking chat or other threads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-status-"));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: string[] = [];
      const fetch = vi.fn<FetchFunction>(async (url, init) => {
        if (apiMethod(url) !== "assistant.threads.setStatus") {
          return slackResponse({ ok: true, ts: "2" });
        }
        const params = formBody(init);
        const status = params.get("status") ?? "";
        sent.push(`${params.get("thread_ts")}:${status}`);
        if (status === "Thinking") await gate;
        return slackResponse({ ok: true });
      });
      const posts = () => fetch.mock.calls.filter(([url]) => apiMethod(url) === "chat.postMessage");
      const bot = new SlackMessagingBot(makeHandler(), {
        appToken: "test",
        botToken: "test",
        workspace: createWorkspace({ root: dir, stateDir: dir }),
        fetch,
      });
      const thinking = bot.setAssistantStatus("C1", "1", "Thinking");
      const clear = bot.setAssistantStatus("C1", "1", "");
      const next = bot.setAssistantStatus("C1", "1", "Next run");
      try {
        await bot.setAssistantStatus("C1", "other", "");
        await bot.postMessage("C1", "answer");
        expect(sent).toEqual(["1:Thinking", "other:"]);
        expect(posts()).toHaveLength(1);
      } finally {
        release();
      }
      await Promise.all([thinking, clear, next]);
      expect(sent).toEqual(["1:Thinking", "other:", "1:", "1:Next run"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("real SDK status client rejects 429 without retry/pause and continues with clear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-status-"));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetch = vi
        .fn<FetchFunction>()
        .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "60" } }))
        .mockResolvedValueOnce(slackResponse({ ok: true }))
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(slackResponse({ ok: true, ts: "2" }));
      const bot = new SlackMessagingBot(makeHandler(), {
        appToken: "test",
        botToken: "test",
        workspace: createWorkspace({ root: dir, stateDir: dir }),
        fetch,
      });
      const thinking = bot.setAssistantStatus("C1", "1", "Thinking");
      const clear = bot.setAssistantStatus("C1", "1", "");
      await expect(thinking).rejects.toMatchObject({
        code: "slack_webapi_rate_limited_error",
      });
      await clear;
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeout.mock.calls).toEqual([[3000], [3000]]);

      await expect(bot.setAssistantStatus("C1", "1", "Retry")).rejects.toMatchObject({
        code: "slack_webapi_http_error",
      });
      expect(fetch).toHaveBeenCalledTimes(3);

      await bot.postMessage("C1", "answer");
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(timeout).toHaveBeenCalledTimes(3);
    } finally {
      timeout.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SlackMessagingBot slash commands", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-bot-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
    workspace = createWorkspace({ root: workingDir, stateDir: workingDir });
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  const alice: SlackMember = { id: "U123", name: "alice", real_name: "Alice" };

  test("/pi-login in a shared channel responds ephemerally without opening a DM", async () => {
    const handler = makeHandler();
    const { bot, web, socket } = await startSlackHarness({
      handler,
      workspace,
      members: [alice],
    });

    await socket.deliver("slash_commands", {
      body: {
        command: "/pi-login",
        text: "github",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: makeAck(),
    });

    expect(web.conversations.open).not.toHaveBeenCalled();

    const firstCall = vi.mocked(handler.handleEvent).mock.calls[0];
    if (!firstCall) throw new Error("expected /pi-login to dispatch an event");
    const [event, calledMessagingBot, context] = firstCall;
    expect(event).toMatchObject({
      type: "private_command",
      address: { conversationId: "C123" },
      conversationKind: "shared",
      user: "U123",
      text: "/pi-login github",
      sessionKey: "C123",
    });
    expect(calledMessagingBot).toBe(bot);

    await context.responder.respond("login link");
    expect(web.chat.postEphemeral).toHaveBeenLastCalledWith({
      channel: "C123",
      user: "U123",
      text: "login link",
    });
    expect(web.chat.postMessage).not.toHaveBeenCalled();
  });

  test("/pi-new routes through the generic dispatch like any other command", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });

    await socket.deliver("slash_commands", {
      body: {
        command: "/pi-new",
        channel_id: "D123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: makeAck(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "D123" },
      conversationKind: "direct",
      sessionKey: "D123",
      text: "/pi-new",
    });
  });

  test("/pi-sandbox in a shared channel routes to command handling ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("sandbox status");
    });

    const { web, socket } = await startSlackHarness({
      handler,
      workspace,
      members: [alice],
    });

    await socket.deliver("slash_commands", {
      body: {
        command: "/pi-sandbox",
        text: "boost",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: makeAck(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "mention",
      address: { conversationId: "C123" },
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-sandbox boost",
    });
    expect(web.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "sandbox status",
    });
  });

  test("/pi-session in a shared channel returns the link ephemerally", async () => {
    const handler = makeHandler();
    handler.handleEvent = vi.fn(async (_event, _bot, context) => {
      await context.responder.respond("session link");
    });

    const { web, socket } = await startSlackHarness({
      handler,
      workspace,
      members: [alice],
    });

    await socket.deliver("slash_commands", {
      body: {
        command: "/pi-session",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
      },
      ack: makeAck(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      type: "mention",
      address: { conversationId: "C123" },
      conversationKind: "shared",
      sessionKey: "C123",
      text: "/pi-session",
    });
    expect(web.chat.postEphemeral).toHaveBeenCalledWith({
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

    const { web, socket } = await startSlackHarness({ handler, workspace });

    await socket.deliver("slash_commands", {
      body: {
        command: "/pi-session",
        channel_id: "C123",
        user_id: "U123",
        user_name: "alice",
        thread_ts: "1000.0001",
      },
      ack: makeAck(),
    });

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C123" },
      conversationKind: "shared",
      sessionKey: "C123:1000.0001",
      thread_ts: "1000.0001",
      text: "/pi-session",
    });
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[2]?.message).toMatchObject({
      sessionKey: "C123:1000.0001",
    });
    expect(web.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "thread session link",
      thread_ts: "1000.0001",
    });
  });
});

describe("SlackMessagingBot queues follow-up messages", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-queue-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
    workspace = createWorkspace({ root: workingDir, stateDir: workingDir });
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  async function occupyQueue(
    harness: SlackHarness,
    handler: MessagingEventHandler,
    message: { eventName: "app_mention" | "message"; event: Record<string, string> },
  ): Promise<() => void> {
    const run = deferred();
    const calls = vi.mocked(handler.handleEvent).mock.calls.length;
    vi.mocked(handler.handleEvent).mockImplementationOnce(() => run.promise);
    await harness.socket.deliver(message.eventName, { event: message.event, ack: makeAck() });
    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(calls + 1));
    return () => run.resolve();
  }

  test("shared channel mentions are queued while the session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "C123",
    );

    const harness = await startSlackHarness({ handler, workspace });
    const { web, socket } = harness;
    const release = await occupyQueue(harness, handler, {
      eventName: "app_mention",
      event: { text: "<@B123> first request", channel: "C123", user: "U123", ts: "1001.0000" },
    });
    const ack = makeAck();

    await socket.deliver("app_mention", {
      event: {
        text: "<@B123> second request",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(web.chat.postMessage).not.toHaveBeenCalled();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    release();

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(handler.handleEvent).mock.calls[1]?.[0]).toMatchObject({
      address: { conversationId: "C123" },
      sessionKey: "C123",
      text: "second request",
    });
  });

  test("auto-reply marker enables unaddressed channel messages", async () => {
    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "");

    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
      event: {
        text: "deployment failed",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C123" },
      text: "deployment failed",
    });
    expect(readFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "utf-8")).toBe("");
  });

  test("shared channel messages trigger only when auto-reply is enabled", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
      event: {
        text: "deployment failed",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "channel",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();
    expect(handler.handleEvent).not.toHaveBeenCalled();

    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "");
    await socket.deliver("message", {
      event: {
        text: "try the deployment again",
        channel: "C123",
        user: "U123",
        ts: "1002.0001",
        channel_type: "channel",
      },
      ack: makeAck(),
    });

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C123" },
      sessionKey: "C123",
      text: "try the deployment again",
    });
  });

  test("jev auto-reply mode asks Jev per message and fails closed on error", async () => {
    evaluateWithJevMock.mockReset();
    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply.jev"), "");

    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });

    evaluateWithJevMock.mockRejectedValueOnce(new Error("gateway down"));
    await socket.deliver("message", {
      event: {
        text: "anyone around?",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        channel_type: "channel",
      },
      ack: makeAck(),
    });
    expect(handler.handleEvent).not.toHaveBeenCalled();

    evaluateWithJevMock.mockResolvedValueOnce({
      answers: { addressed: { type: "boolean", probability: 0.92 } },
    });
    await socket.deliver("message", {
      event: {
        text: "mikan can you redeploy the service",
        channel: "C123",
        user: "U123",
        ts: "1002.0001",
        channel_type: "channel",
      },
      ack: makeAck(),
    });

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C123" },
      text: "mikan can you redeploy the service",
    });
    expect(evaluateWithJevMock).toHaveBeenCalledWith(
      expect.stringContaining("NEW message from U123:\nmikan can you redeploy the service"),
      expect.objectContaining({ addressed: expect.objectContaining({ type: "boolean" }) }),
      expect.objectContaining({ caller: "slack_auto_reply" }),
    );
  });

  test("jev auto-reply mode judges bare thread replies with the thread as context", async () => {
    evaluateWithJevMock.mockReset();
    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply.jev"), "");
    writeFileSync(
      join(workingDir, C123_OFFICE, "log.jsonl"),
      [
        { ts: "1000.0001", user: "U123", displayName: "Ann", text: "<@B123> check the deploy" },
        {
          ts: "1000.0002",
          threadTs: "1000.0001",
          user: "bot",
          isMessagingBot: true,
          text: "Looks ",
        },
        {
          ts: "1000.0002",
          threadTs: "1000.0001",
          user: "bot",
          isMessagingBot: true,
          text: "green.",
        },
        { ts: "1000.0003", user: "U999", displayName: "Bob", text: "unrelated top-level chatter" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );

    const handler = makeHandler();
    const { socket } = await startSlackHarness({
      handler,
      workspace,
      members: [{ id: "U999", name: "bob", real_name: "Bob" }],
    });

    evaluateWithJevMock.mockResolvedValueOnce({
      answers: { addressed: { type: "boolean", probability: 0.8 } },
    });
    const ack = makeAck();
    await socket.deliver("message", {
      event: {
        text: "<@U999> then roll it back please <@UNKNOWN>",
        channel: "C123",
        user: "U123",
        ts: "1001.0001",
        thread_ts: "1000.0001",
        channel_type: "channel",
      },
      ack,
    });

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(ack).toHaveBeenCalled();
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "C123" },
      sessionKey: "C123:1000.0001",
      text: "<@U999> then roll it back please <@UNKNOWN>",
    });
    const state = evaluateWithJevMock.mock.calls[0]?.[0] as string;
    expect(state).toContain("mikan has already replied in this thread");
    expect(state).toContain("- Ann: @mikan check the deploy");
    expect(state).toContain("- mikan: Looks green.");
    expect(state).not.toContain("unrelated top-level chatter");
    expect(state).toContain("NEW message from U123:\n@Bob then roll it back please @UNKNOWN");
  });

  test("DM stop is handled immediately and bypasses the intake queue", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "D123",
    );
    const { bot, socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
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
    await bot.stop();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("bare shared channel stop does not trigger auto-reply", async () => {
    mkdirSync(join(workingDir, C123_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, C123_OFFICE, "auto-reply"), "");

    const handler = makeHandler();
    const { bot, web, socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
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
    await bot.stop();
    expect(web.chat.postMessage).not.toHaveBeenCalled();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("bare shared channel mentions ask the agent to use recent context", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("app_mention", {
      event: {
        text: "<@B123>",
        channel: "C123",
        user: "U123",
        ts: "1001.00015",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      text: "Please respond to the recent conversation context.",
    });
  });

  test("shared channel mentions preserve mentions of other users", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("app_mention", {
      event: {
        text: "<@B123> ask <@U999> about this",
        channel: "C123",
        user: "U123",
        ts: "1001.00015",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      text: "ask <@U999> about this",
    });
  });

  test("first shared-channel thread reply waits behind the channel queue until the thread session exists", async () => {
    const handler = makeHandler();
    const harness = await startSlackHarness({ handler, workspace });
    const release = await occupyQueue(harness, handler, {
      eventName: "app_mention",
      event: { text: "<@B123> top-level request", channel: "C123", user: "U123", ts: "1001.0" },
    });
    const ack = makeAck();

    await harness.socket.deliver("app_mention", {
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
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(handler.handleEvent).mock.calls[1]?.[0]).toMatchObject({
      sessionKey: "C123:1000.0001",
      text: "thread request",
    });
  });

  test("shared-channel bare thread replies do not trigger after the thread session exists", async () => {
    const handler = makeHandler();
    const { bot, socket } = await startSlackHarness({ handler, workspace });

    const conversationDir = join(workingDir, C123_OFFICE);
    createManagedSessionFileAtPath(join(conversationDir, "session.jsonl"), conversationDir);
    createManagedSessionFileAtPath(
      getThreadSessionFile(conversationDir, "C123:1000.0001"),
      conversationDir,
    );

    const ack = makeAck();

    await socket.deliver("message", {
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
    await bot.stop();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("Slack events create a top-level anchor and run under that thread session", async () => {
    const handler = makeHandler();
    const handled = new Promise<void>((resolve, reject) => {
      handler.handleEvent = vi.fn(async (event, _calledMessagingBot, context) => {
        try {
          expect(event).toMatchObject({
            address: { conversationId: "C123" },
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

    const { bot } = createSlackHarness({ handler, workspace });
    const postMessage = vi.spyOn(bot, "postMessage").mockResolvedValue("2000.0001");
    const updateMessage = vi.spyOn(bot, "updateMessage").mockResolvedValue(undefined);

    expect(
      bot.enqueueEvent({
        type: "mention",
        address: createOfficeAddress("slack", "C123"),
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

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith("C123", "Working on it...");
    expect(updateMessage).toHaveBeenCalledWith(
      "C123",
      "2000.0001",
      expect.stringContaining("event done"),
    );
    expect(existsSync(getThreadSessionFile(join(workingDir, C123_OFFICE), "C123:2000.0001"))).toBe(
      true,
    );
  });

  test("postInThread wraps text in a markdown block", async () => {
    const { bot, web } = createSlackHarness({ handler: makeHandler(), workspace });

    await bot.postInThread("C123", "1000.0001", "x".repeat(600));

    expect(web.chat.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1000.0001",
      text: "x".repeat(600),
      blocks: [{ type: "markdown", text: "x".repeat(600) }],
    });
  });

  test("Slack events report anchor failures instead of creating legacy event sessions", async () => {
    const handler = makeHandler();
    const { bot } = createSlackHarness({ handler, workspace });

    const postMessage = vi
      .spyOn(bot, "postMessage")
      .mockRejectedValueOnce(new Error("anchor failed"));
    const updateMessage = vi.spyOn(bot, "updateMessage").mockResolvedValue(undefined);

    expect(
      bot.enqueueEvent({
        type: "mention",
        address: createOfficeAddress("slack", "C123"),
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
    expect(updateMessage).not.toHaveBeenCalled();
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
    let eventRunFinished = false;
    handler.handleEvent = vi.fn(async (event, _calledMessagingBot, context) => {
      try {
        expect(event).toMatchObject({
          address: { conversationId: "C123" },
          sessionKey: "C123:2000.0001",
        });
        expect(context.message.sessionKey).toBe("C123:2000.0001");
        resolveEventHandled();
        await eventRunCanFinish;
        eventRunFinished = true;
      } catch (err) {
        rejectEventHandled(err);
      }
    });

    const { bot, socket } = await startSlackHarness({ handler, workspace });
    vi.spyOn(bot, "postMessage").mockResolvedValue("2000.0001");
    vi.spyOn(bot, "updateMessage").mockResolvedValue(undefined);

    expect(
      bot.enqueueEvent({
        type: "mention",
        address: createOfficeAddress("slack", "C123"),
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

    expect(existsSync(getThreadSessionFile(join(workingDir, C123_OFFICE), "C123:2000.0001"))).toBe(
      true,
    );
    expect(eventRunFinished).toBe(false);
    const ack = makeAck();

    await socket.deliver("message", {
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
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    releaseEventRun();
    await eventHandled;
    await bot.stop();

    expect(eventRunFinished).toBe(true);
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("external Slack app bot messages are logged but do not trigger mikan", async () => {
    const handler = makeHandler();
    const { bot, socket } = await startSlackHarness({
      handler,
      workspace,
      auth: { user_id: "U_MIKAN", bot_id: "B_MIKAN" },
    });

    const ack = makeAck();
    await socket.deliver("message", {
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
    await vi.waitFor(() =>
      expect(readLogEntries(workspace, "C123")).toEqual([
        expect.objectContaining({ ts: "1001.0003", botId: "B_SENTRY", userName: "Sentry" }),
      ]),
    );
    await bot.stop();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies do not trigger for unrelated threads", async () => {
    const handler = makeHandler();
    const { bot, socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
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
    await bot.stop();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("shared-channel bare thread replies do not trigger while that thread session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "C123:1000.0001",
    );

    const { bot, socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
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
    await bot.stop();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM follow-up messages are queued while the top-level DM session is running", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "D123",
    );

    const harness = await startSlackHarness({ handler, workspace });
    const release = await occupyQueue(harness, handler, {
      eventName: "message",
      event: {
        text: "first request",
        channel: "D123",
        user: "U123",
        ts: "2001.0000",
        channel_type: "im",
      },
    });
    const ack = makeAck();

    await harness.socket.deliver("message", {
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
    expect(harness.web.chat.postMessage).not.toHaveBeenCalled();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    release();

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(handler.handleEvent).mock.calls[1]?.[0]).toMatchObject({
      address: { conversationId: "D123" },
      sessionKey: "D123",
      text: "second request",
    });
  });

  test("first DM thread reply waits behind the top-level DM queue until the thread session exists", async () => {
    const handler = makeHandler();
    const harness = await startSlackHarness({ handler, workspace });
    const release = await occupyQueue(harness, handler, {
      eventName: "message",
      event: {
        text: "top-level request",
        channel: "D123",
        user: "U123",
        ts: "2001.0000",
        channel_type: "im",
      },
    });
    const ack = makeAck();

    await harness.socket.deliver("message", {
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
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(handler.handleEvent).mock.calls[1]?.[0]).toMatchObject({
      sessionKey: "D123:2000.0001",
      text: "thread request",
    });
  });

  test("DM message without channel_type still routes as a direct message", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });
    const ack = makeAck();

    await socket.deliver("message", {
      event: {
        text: "dm without channel_type",
        channel: "D999",
        user: "U123",
        ts: "2001.0001",
      },
      ack,
    });

    expect(ack).toHaveBeenCalled();

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "D999" },
      conversationKind: "direct",
      sessionKey: "D999",
      text: "dm without channel_type",
    });
  });

  test("DM posted via a user token (human user plus bot_id) routes as a user message", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({
      handler,
      workspace,
      members: [{ id: "UHUMAN", name: "qa-human", real_name: "QA Human", is_bot: false }],
    });
    const ack = makeAck();

    await socket.deliver("message", {
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

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      address: { conversationId: "D999" },
      user: "UHUMAN",
      text: "dm posted with a user token",
    });
  });

  test("DM from a bot user keeps the external-bot ignore path", async () => {
    const handler = makeHandler();
    const { bot, socket } = await startSlackHarness({
      handler,
      workspace,
      members: [{ id: "UOTHERBOT", name: "other-bot", real_name: "Other Bot", is_bot: true }],
    });
    const ack = makeAck();

    await socket.deliver("message", {
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
    await bot.stop();
    expect(readLogEntries(workspace, "D999")).toEqual([
      expect.objectContaining({ ts: "2001.0001", botId: "BOTHERBOT", isMessagingBot: true }),
    ]);
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("DM thread follow-up messages are queued on the thread session key once the thread session exists", async () => {
    const handler = makeHandler();
    vi.mocked(handler.isRunning).mockImplementation(
      (_address, sessionKey) => sessionKey === "D123:2000.0001",
    );

    createManagedSessionFileAtPath(
      getThreadSessionFile(join(workingDir, "D123"), "D123:2000.0001"),
      join(workingDir, "D123"),
    );

    const harness = await startSlackHarness({ handler, workspace });
    const releaseTopLevel = await occupyQueue(harness, handler, {
      eventName: "message",
      event: {
        text: "top-level request",
        channel: "D123",
        user: "U123",
        ts: "2000.9999",
        channel_type: "im",
      },
    });
    const releaseThread = await occupyQueue(harness, handler, {
      eventName: "message",
      event: {
        text: "earlier thread request",
        channel: "D123",
        user: "U123",
        ts: "2001.0000",
        thread_ts: "2000.0001",
        channel_type: "im",
      },
    });
    const ack = makeAck();

    await harness.socket.deliver("message", {
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
    expect(handler.handleEvent).toHaveBeenCalledTimes(2);

    releaseThread();

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(3));
    expect(vi.mocked(handler.handleEvent).mock.calls[2]?.[0]).toMatchObject({
      address: { conversationId: "D123" },
      sessionKey: "D123:2000.0001",
      text: "thread request",
      thread_ts: "2000.0001",
    });
    releaseTopLevel();
  });
});

describe("SlackMessagingBot backfill", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-backfill-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
    workspace = createWorkspace({ root: workingDir, stateDir: workingDir });
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  const c123: SlackConversation = { id: "C123", name: "general", is_member: true };

  function prepareBackfilledChannel(): void {
    const office = workspace.office(createOfficeAddress("slack", "C123"));
    office.ensure();
    writeFileSync(office.logPath, "");
  }

  async function backfillC123(
    options: Omit<SlackHarnessOptions, "workspace" | "channels">,
    history: SlackWebApi["conversations"]["history"],
    expectedEntries: number,
  ): Promise<Array<Record<string, unknown>>> {
    prepareBackfilledChannel();
    const harness = createSlackHarness({ ...options, workspace, channels: [c123] });
    vi.mocked(harness.web.conversations.history).mockImplementation(history);
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await harness.bot.start();
    } finally {
      now.mockRestore();
    }
    await vi.waitFor(() => expect(harness.web.conversations.history).toHaveBeenCalled());
    await vi.waitFor(() => expect(readLogEntries(workspace, "C123")).toHaveLength(expectedEntries));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.bot.stop();
    return readLogEntries(workspace, "C123");
  }

  test("backfill keeps distinct human, external-bot, and own-message admission rules", async () => {
    const messages = [
      { user: "U_SELF", subtype: "message_changed" },
      { bot_id: "B_SELF", text: "own bot identity" },
      { user: "U1", blocks: [{}] },
      { user: "U1", text: "human" },
      { bot_id: "B_OTHER", blocks: [{}] },
      { subtype: "bot_message", attachments: [{}] },
      { bot_id: "B_OTHER", subtype: "message_changed", text: "unsupported" },
      { user: "U1", subtype: "message_changed", text: "unsupported" },
      { user: "U1", files: [] },
      { text: "no author" },
    ].map((message, index) => Object.assign(message, { ts: `1000.${index}` }));

    const entries = await backfillC123(
      { handler: makeHandler(), auth: { user_id: "U_SELF", bot_id: "B_SELF" } },
      async () => ({ ok: true, messages }),
      4,
    );

    expect(entries.map((entry) => [entry.ts, entry.user])).toEqual([
      ["1000.5", "external-bot"],
      ["1000.4", "bot:B_OTHER"],
      ["1000.3", "U1"],
      ["1000.0", "bot"],
    ]);
  });

  test("backfill preserves threadTs for thread replies", async () => {
    const entries = await backfillC123(
      {
        handler: makeHandler(),
        members: [{ id: "U123", name: "alice", real_name: "Alice" }],
      },
      async () => ({
        ok: true,
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
      1,
    );

    expect(entries).toHaveLength(1);
    const logContent = readFileSync(
      join(workingDir, officeKey(createOfficeAddress("slack", "C123")), "log.jsonl"),
      "utf-8",
    );
    expect(logContent).toContain('"threadTs":"1000.0001"');
  });

  test("fetchHistory reads top-level messages oldest-first", async () => {
    const { bot, web } = createSlackHarness({
      handler: makeHandler(),
      workspace,
      members: [{ id: "U123", name: "alice", real_name: "Alice", is_bot: false }],
    });
    await bot.listUsers();
    vi.mocked(web.conversations.history).mockResolvedValue({
      ok: true,
      messages: [
        { user: "U123", text: "second", ts: "1000.0002" },
        { user: "U123", text: "first", ts: "1000.0001" },
      ],
    });

    const result = await bot.fetchHistory("C123", { oldest: "999.0", limit: 50 });

    expect(web.conversations.replies).not.toHaveBeenCalled();
    expect(web.conversations.history).toHaveBeenCalledWith({
      channel: "C123",
      oldest: "999.0",
      inclusive: false,
      limit: 50,
    });
    expect(result.map((message) => message.text)).toEqual(["first", "second"]);
    expect(result[0]).toMatchObject({ ts: "1000.0001", userId: "U123", userName: "alice" });
  });

  test("fetchHistory with threadTs reads the thread's replies and drops the parent", async () => {
    const { bot, web } = createSlackHarness({
      handler: makeHandler(),
      workspace,
      members: [{ id: "U123", name: "alice", real_name: "Alice", is_bot: false }],
    });
    await bot.listUsers();
    vi.mocked(web.conversations.replies).mockResolvedValue({
      ok: true,
      messages: [
        { bot_id: "B_MIKAN", text: "follow-up request", ts: "1000.0001" },
        { user: "U123", text: "done, shipped it", ts: "1000.0002", thread_ts: "1000.0001" },
        { user: "U123", text: "and closed the issue", ts: "1000.0003", thread_ts: "1000.0001" },
      ],
    });

    const result = await bot.fetchHistory("C123", { threadTs: "1000.0001" });

    expect(web.conversations.history).not.toHaveBeenCalled();
    expect(web.conversations.replies).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1000.0001",
      limit: 200,
    });
    expect(result.map((message) => message.text)).toEqual([
      "done, shipped it",
      "and closed the issue",
    ]);
    expect(result[0]).toMatchObject({ threadTs: "1000.0001", isBot: false });
  });

  test("backfill logs external app bot messages", async () => {
    const entries = await backfillC123(
      { handler: makeHandler(), auth: { user_id: "U_MIKAN", bot_id: "B_MIKAN" } },
      async () => ({
        ok: true,
        messages: [
          {
            bot_id: "B_SENTRY",
            app_id: "A_SENTRY",
            username: "Sentry",
            subtype: "bot_message",
            text: "[pi-agent] Test Issue",
            blocks: sdkHistoryBlocks([
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
            ]),
            ts: "1000.0002",
          },
        ],
        response_metadata: {},
      }),
      1,
    );

    expect(entries).toHaveLength(1);
    const logContent = readFileSync(
      join(workingDir, officeKey(createOfficeAddress("slack", "C123")), "log.jsonl"),
      "utf-8",
    );
    expect(logContent).toContain('"userName":"Sentry"');
    expect(logContent).toContain("[pi-agent] Test Issue");
    expect(logContent).toContain("poll(.../sentry/scripts/views.js)");
    expect(logContent).toContain("PI-AGENT-A");
    expect(logContent).toContain('"botId":"B_SENTRY"');
  });

  test("backfill preserves mentions of other users while stripping mikan", async () => {
    const entries = await backfillC123(
      {
        handler: makeHandler(),
        members: [{ id: "U123", name: "alice", real_name: "Alice" }],
      },
      async () => ({
        ok: true,
        messages: [
          {
            user: "U123",
            text: "<@B123> ask <@U999> about this",
            ts: "1000.0002",
          },
        ],
        response_metadata: {},
      }),
      1,
    );

    expect(entries).toHaveLength(1);
    const logContent = readFileSync(
      join(workingDir, officeKey(createOfficeAddress("slack", "C123")), "log.jsonl"),
      "utf-8",
    );
    expect(logContent).toContain('"text":"ask <@U999> about this"');
  });
});

describe("SlackMessagingBot attachments", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-attachments-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
    workspace = createWorkspace({ root: workingDir, stateDir: workingDir });
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("waits for attachment downloads before invoking the agent", async () => {
    const handler = makeHandler();
    const download = deferred<Response>();
    const fetch = vi.fn<FetchFunction>(() => download.promise);
    const { socket } = await startSlackHarness({ handler, workspace, fetch });

    const ack = makeAck();
    await socket.deliver("app_mention", {
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
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("https://example.com/clip.mov", {
        headers: { Authorization: "Bearer xoxb-test" },
      }),
    );
    await Promise.resolve();
    expect(handler.handleEvent).not.toHaveBeenCalled();

    download.resolve(new Response("clip"));

    await vi.waitFor(() => expect(handler.handleEvent).toHaveBeenCalledTimes(1));
    const localPath = `${C123_OFFICE}/attachments/1001000_clip.mov`;
    expect(vi.mocked(handler.handleEvent).mock.calls[0]?.[0]).toMatchObject({
      attachments: [{ original: "clip.mov", localPath }],
    });
    expect(readFileSync(join(workingDir, localPath), "utf-8")).toBe("clip");
  });
});

describe("SlackMessagingBot force-stop block action", () => {
  let workingDir: string;
  let workspace: Workspace;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), "mikan-slack-forcestop-"));
    process.env.MIKAN_STATE_DIR = workingDir;
    createGlobalSettingsFile(workingDir);
    workspace = createWorkspace({ root: workingDir, stateDir: workingDir });
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  test("session keys with underscored conversation ids survive via the button value", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });
    const sessionKey = "GH_owner_repo_42:1000.0001";

    await socket.deliver("block_actions", {
      body: {
        actions: [
          {
            action_id: `force_stop_${sessionKey.replace(/:/g, "_")}`,
            value: sessionKey,
          },
        ],
        user: { id: "U123" },
        container: {},
      },
      ack: makeAck(),
    });

    expect(handler.forceStop).toHaveBeenCalledWith(
      createOfficeAddress("slack", "GH_owner_repo_42"),
      sessionKey,
    );
  });

  test("legacy buttons without a value fall back to action_id decoding", async () => {
    const handler = makeHandler();
    const { socket } = await startSlackHarness({ handler, workspace });

    await socket.deliver("block_actions", {
      body: {
        actions: [{ action_id: "force_stop_C123_1000.0001" }],
        user: { id: "U123" },
        container: { channel_id: "C123" },
      },
      ack: makeAck(),
    });

    expect(handler.forceStop).toHaveBeenCalledWith(
      createOfficeAddress("slack", "C123"),
      "C123:1000.0001",
    );
  });
});
