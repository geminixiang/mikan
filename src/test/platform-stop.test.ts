import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection, type Guild } from "discord.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConversationEvent, createWorkspace } from "../office/index.js";
import type { Workspace } from "../office/types.js";
import { DiscordMessagingBot } from "../adapters/discord/bot.js";
import type { DiscordClient } from "../adapters/discord/types.js";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import type { GithubApi } from "../adapters/github/types.js";
import { SlackMessagingBot } from "../adapters/slack/bot.js";
import type { SlackSocketConnection } from "../adapters/slack/types.js";
import { TelegramMessagingBot } from "../adapters/telegram/bot.js";
import type { TelegramClient } from "../adapters/telegram/types.js";
import { MessagingEventQueue, MessagingIntakeTracker } from "../adapters/shared.js";
import type { MessagingEventHandler } from "../types.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unexpectedCall = async (): Promise<never> => {
  throw new Error("unexpected platform client call");
};

function fakeHandler(): MessagingEventHandler {
  return {
    isRunning: () => false,
    getRunningSessions: () => [],
    handleEvent: vi.fn(async () => {}),
    handleStop: vi.fn(async () => {}),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(async () => {}),
  };
}

function fakeSlackSocket(
  disconnect: SlackSocketConnection["disconnect"] = async () => {},
): SlackSocketConnection {
  return { on: () => undefined, start: async () => {}, disconnect };
}

function fakeDiscordClient(destroy: DiscordClient["destroy"] = async () => {}): DiscordClient {
  return {
    channels: { fetch: unexpectedCall },
    users: { fetch: unexpectedCall },
    guilds: { cache: new Collection<string, Guild>() },
    once: () => undefined,
    on: () => undefined,
    login: unexpectedCall,
    destroy,
  };
}

function fakeTelegramClient(stop: TelegramClient["stop"] = async () => {}): TelegramClient {
  return {
    api: {
      getMe: unexpectedCall,
      setMyCommands: unexpectedCall,
      setMessageReaction: unexpectedCall,
      editMessageText: unexpectedCall,
      sendRichMessage: unexpectedCall,
      sendMessage: unexpectedCall,
      deleteMessage: unexpectedCall,
      sendChatAction: unexpectedCall,
      sendDocument: unexpectedCall,
      getFile: unexpectedCall,
    },
    catch: () => {},
    start: async () => {},
    stop,
    command: () => undefined,
    on: () => undefined,
  };
}

function fakeGithubApi(overrides: Partial<GithubApi> = {}): GithubApi {
  return {
    getAppSlug: unexpectedCall,
    getUserId: unexpectedCall,
    createScopedInstallationToken: unexpectedCall,
    getRepository: unexpectedCall,
    getCollaboratorPermission: unexpectedCall,
    createPullRequest: unexpectedCall,
    getPullRequest: unexpectedCall,
    listPullRequestFiles: unexpectedCall,
    listPullRequestReviews: unexpectedCall,
    listIssueComments: unexpectedCall,
    listIssues: unexpectedCall,
    findOpenPullRequestByBranch: unexpectedCall,
    listCheckRuns: unexpectedCall,
    getJobLog: unexpectedCall,
    listInstallationRepositories: unexpectedCall,
    listIssueCommentsSince: unexpectedCall,
    listPullReviewCommentsSince: unexpectedCall,
    listPullReviewComments: unexpectedCall,
    listIssuesSince: unexpectedCall,
    getIssue: unexpectedCall,
    addIssueLabels: unexpectedCall,
    removeIssueLabel: unexpectedCall,
    addIssueAssignees: unexpectedCall,
    removeIssueAssignees: unexpectedCall,
    updateIssueState: unexpectedCall,
    createIssueComment: unexpectedCall,
    updateIssueComment: unexpectedCall,
    deleteIssueComment: unexpectedCall,
    createCommentReaction: unexpectedCall,
    replyToReviewComment: unexpectedCall,
    createReviewCommentReaction: unexpectedCall,
    createIssueReaction: unexpectedCall,
    ...overrides,
  };
}

let root: string;
let workspace: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mikan-platform-stop-"));
  workspace = createWorkspace({ root, stateDir: join(root, "state") });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function slackBot(socket: SlackSocketConnection = fakeSlackSocket()): SlackMessagingBot {
  return new SlackMessagingBot(fakeHandler(), {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    workspace,
    socket,
  });
}

function discordBot(client: DiscordClient = fakeDiscordClient()): DiscordMessagingBot {
  return new DiscordMessagingBot(fakeHandler(), { token: "discord-test", workspace, client });
}

function telegramBot(client: TelegramClient = fakeTelegramClient()): TelegramMessagingBot {
  return new TelegramMessagingBot(fakeHandler(), { token: "telegram-test", workspace, client });
}

function githubBot(client: GithubApi = fakeGithubApi()): GithubMessagingBot {
  return new GithubMessagingBot(
    fakeHandler(),
    {
      appId: "1",
      privateKey: "unused",
      installationId: "2",
      repos: ["octo/widgets"],
      pollIntervalMs: 60_000,
      workspace,
      syncStatePath: join(root, "github-sync.json"),
    },
    client,
  );
}

describe("MessagingIntakeTracker.close", () => {
  test("rejects new callbacks and waits for active intake", async () => {
    const gate = createDeferred();
    const calls: string[] = [];
    const intake = new MessagingIntakeTracker("test");
    const active = intake.run(async () => {
      calls.push("active");
      await gate.promise;
    });

    const closing = intake.close();
    await intake.run(() => {
      calls.push("late");
    });
    await Promise.resolve();
    expect(calls).toEqual(["active"]);

    gate.resolve();
    await Promise.all([active, closing]);
  });
});

describe("MessagingEventQueue.close", () => {
  test("rejects new work and waits for accepted work to drain", async () => {
    const gate = createDeferred();
    const calls: string[] = [];
    const queue = new MessagingEventQueue("test");
    queue.enqueue(async () => {
      calls.push("first");
      await gate.promise;
    });
    queue.enqueue(async () => {
      calls.push("second");
    });

    const closing = queue.close();
    queue.enqueue(async () => {
      calls.push("late");
    });
    await Promise.resolve();
    expect(calls).toEqual(["first"]);

    gate.resolve();
    await closing;
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("platform stop intake", () => {
  test("rejects scheduled events after every adapter is stopped", async () => {
    const event = createConversationEvent({
      platform: "slack",
      type: "mention",
      conversationId: "C1",
      conversationKind: "shared",
      user: "EVENT",
      text: "late event",
      ts: "event:late",
    });
    const bots = [slackBot(), discordBot(), telegramBot(), githubBot()];

    for (const bot of bots) await bot.stop();

    for (const bot of bots) expect(bot.enqueueEvent(event)).toBe(false);
  });

  test("disconnects Slack Socket Mode", async () => {
    const disconnect = vi.fn(async () => {});
    const bot = slackBot(fakeSlackSocket(disconnect));

    await bot.stop();

    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("destroys the Discord client", async () => {
    const destroy = vi.fn(async () => {});
    const bot = discordBot(fakeDiscordClient(destroy));

    await bot.stop();

    expect(destroy).toHaveBeenCalledOnce();
  });

  test("stops Telegram polling", async () => {
    const stop = vi.fn(async () => {});
    const bot = telegramBot(fakeTelegramClient(stop));

    await bot.stop();

    expect(stop).toHaveBeenCalledOnce();
  });

  test("clears GitHub timers and waits for an active poll", async () => {
    const gate = createDeferred();
    const listIssuesSince = vi.fn<GithubApi["listIssuesSince"]>(async () => {
      await gate.promise;
      return [];
    });
    const bot = githubBot(
      fakeGithubApi({
        getAppSlug: async () => "mikan",
        getUserId: async () => 1,
        listIssuesSince,
        listIssueCommentsSince: async () => [],
        listPullReviewCommentsSince: async () => [],
      }),
    );
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    await bot.start();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    const interval = setIntervalSpy.mock.results[0]!.value;

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    bot.requestPoll(60_000);
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    const requestTimer = setTimeoutSpy.mock.results[0]!.value;
    setTimeoutSpy.mockClear();

    const polling = bot.poll();
    await vi.waitFor(() => expect(listIssuesSince).toHaveBeenCalledOnce());
    bot.requestPoll(0);

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let settled = false;
    const stopping = bot.stop().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(requestTimer);

    gate.resolve();
    await Promise.all([polling, stopping]);
    expect(settled).toBe(true);

    setTimeoutSpy.mockClear();
    bot.requestPoll(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
