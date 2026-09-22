import { describe, expect, test, vi } from "vitest";
import { DiscordMessagingBot } from "../adapters/discord/bot.js";
import type { DiscordEvent } from "../adapters/discord/bot.js";
import { createDiscordAdapters } from "../adapters/discord/context.js";
import { DISCORD_V2_TEXT_LIMIT } from "../adapters/discord/components.js";
import { createOfficeAddress } from "../office/index.js";

function makeDiscordMessagingBot(
  overrides: Partial<DiscordMessagingBot> = {},
): DiscordMessagingBot {
  return {
    postReply: vi.fn().mockResolvedValue("MSG002"),
    postInThread: vi.fn().mockResolvedValue("MSG003"),
    updateMessageRaw: vi.fn().mockResolvedValue(undefined),
    deleteMessageRaw: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    getAllChannels: vi.fn().mockReturnValue([]),
    getAllUsers: vi.fn().mockReturnValue([]),
    start: vi.fn(),
    postMessage: vi.fn().mockResolvedValue("MSG001"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    enqueueEvent: vi.fn().mockReturnValue(true),
    getMessagingInfo: DiscordMessagingBot.prototype.getMessagingInfo,
    ...overrides,
  } as unknown as DiscordMessagingBot;
}

function makeEvent(overrides: Partial<DiscordEvent> = {}): DiscordEvent {
  return {
    type: "mention",
    address: createOfficeAddress("discord", "CH001"),
    conversationKind: "shared",
    ts: "MSG001",
    user: "U001",
    text: "hello",
    ...overrides,
  };
}

describe("subagent dashboard", () => {
  test("does not override the harness's response-source dashboard", () => {
    const bot = makeDiscordMessagingBot();
    const { responder } = createDiscordAdapters(makeEvent(), bot);
    expect(responder.replaceSubagentProgress).toBeUndefined();
  });
});

describe("react", () => {
  test("targets the triggering message", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "MSG001" });
    const { responder } = createDiscordAdapters(event, bot);

    await responder.react!("eyes");
    expect(bot.addReaction).toHaveBeenCalledWith("CH001", "MSG001", "eyes");
  });

  test("is unavailable for a synthetic (event-triggered) message reference", () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responder } = createDiscordAdapters(event, bot);

    expect(responder.react).toBeUndefined();
  });
});

describe("session key derivation", () => {
  test("non-threaded: sessionKey = channel", () => {
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { message } = createDiscordAdapters(event, makeDiscordMessagingBot());
    expect(message.sessionKey).toBe("CH001");
  });

  test("threaded: sessionKey = channel:thread_ts", () => {
    const event = makeEvent({ ts: "MSG003", thread_ts: "MSG001" });
    const { message } = createDiscordAdapters(event, makeDiscordMessagingBot());
    expect(message.sessionKey).toBe("CH001:MSG001");
  });

  test("message id is always event.ts", () => {
    const event = makeEvent({ ts: "MSG005", thread_ts: "MSG001" });
    const { message } = createDiscordAdapters(event, makeDiscordMessagingBot());
    expect(message.id).toBe("MSG005");
  });

  test("different threads in same channel produce different session keys", () => {
    const event1 = makeEvent({ ts: "MSG003", thread_ts: "MSG001" });
    const event2 = makeEvent({ ts: "MSG006", thread_ts: "MSG004" });
    const { message: m1 } = createDiscordAdapters(event1, makeDiscordMessagingBot());
    const { message: m2 } = createDiscordAdapters(event2, makeDiscordMessagingBot());
    expect(m1.sessionKey).toBe("CH001:MSG001");
    expect(m2.sessionKey).toBe("CH001:MSG004");
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
  });

  test("top-level follow-ups in same channel reuse the same session key", () => {
    const event1 = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const event2 = makeEvent({ ts: "MSG002", thread_ts: undefined });
    const { message: m1 } = createDiscordAdapters(event1, makeDiscordMessagingBot());
    const { message: m2 } = createDiscordAdapters(event2, makeDiscordMessagingBot());
    expect(m1.sessionKey).toBe("CH001");
    expect(m2.sessionKey).toBe("CH001");
  });
});

describe("respond() — non-threaded (replies to trigger message)", () => {
  test("first call posts as reply to the trigger message", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postReply).toHaveBeenCalledWith("CH001", "MSG001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeDiscordMessagingBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("first");
    await responder.respond("second");
    expect(bot.postReply).toHaveBeenCalledTimes(1);
    expect(bot.updateMessageRaw).toHaveBeenCalledWith(
      "CH001",
      "REPLY001",
      expect.stringContaining("second"),
    );
  });

  test("update call accumulates text with newline", async () => {
    const bot = makeDiscordMessagingBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("line1");
    await responder.respond("line2");
    const updateCall = vi.mocked(bot.updateMessageRaw).mock.calls[0];
    expect(updateCall[2]).toContain("line1");
    expect(updateCall[2]).toContain("line2");
  });

  test("synthetic event without a Discord message id posts to the channel", async () => {
    const bot = makeDiscordMessagingBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({
      ts: "event:one-shot-1777454334068.json",
      thread_ts: undefined,
      text: "run",
    });
    const { responder } = createDiscordAdapters(event, bot, true);
    await responder.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("CH001", expect.stringContaining("hello"));
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

describe("respond() — threaded", () => {
  test("first call posts in thread", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "CH001",
      "THREAD001",
      expect.stringContaining("hello"),
    );
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("subsequent calls update the thread message", async () => {
    const bot = makeDiscordMessagingBot({
      postInThread: vi.fn().mockResolvedValue("THREAD_MSG001"),
    });
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("first");
    await responder.respond("second");
    expect(bot.postInThread).toHaveBeenCalledTimes(1);
    expect(bot.updateMessageRaw).toHaveBeenCalledWith(
      "CH001",
      "THREAD_MSG001",
      expect.stringContaining("second"),
    );
  });
});

describe("respondDiagnostic()", () => {
  test("non-threaded: posts as a reply to the trigger message", async () => {
    const bot = makeDiscordMessagingBot({ postReply: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("main");
    vi.clearAllMocks();
    await responder.respondDiagnostic("detail");
    expect(bot.postReply).toHaveBeenCalledWith("CH001", "MSG001", "detail");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("threaded: posts in the platform thread", async () => {
    const bot = makeDiscordMessagingBot({ postInThread: vi.fn().mockResolvedValue("THREAD_MSG") });
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("main");
    vi.clearAllMocks();
    await responder.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith("CH001", "THREAD001", "detail");
  });

  test("non-threaded: can post before a main message exists", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respondDiagnostic("detail");
    expect(bot.postReply).toHaveBeenCalledWith("CH001", "MSG001", "detail");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("respondToolResult formats and posts diagnostics", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respondToolResult({
      toolName: "bash",
      label: "list files",
      args: { label: "list files", command: "ls" },
      result: "ok",
      isError: false,
      durationMs: 1200,
    });
    expect(bot.postReply).toHaveBeenCalledWith(
      "CH001",
      "MSG001",
      expect.stringContaining("**Done bash**: list files"),
    );
  });

  test("synthetic event: diagnostics after main response reply to bot message", async () => {
    const bot = makeDiscordMessagingBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({
      ts: "event:one-shot-1777454334068.json",
      thread_ts: undefined,
      text: "run",
    });
    const { responder } = createDiscordAdapters(event, bot, true);
    await responder.respond("main");
    vi.clearAllMocks();
    await responder.respondDiagnostic("detail");
    expect(bot.postReply).toHaveBeenCalledWith("CH001", "BOT_MSG", "detail");
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("synthetic event: diagnostics before main response post to the channel", async () => {
    const bot = makeDiscordMessagingBot({ postMessage: vi.fn().mockResolvedValue("DIAG_MSG") });
    const event = makeEvent({
      ts: "event:one-shot-1777454334068.json",
      thread_ts: undefined,
      text: "run",
    });
    const { responder } = createDiscordAdapters(event, bot, true);
    await responder.respondDiagnostic("detail");
    expect(bot.postMessage).toHaveBeenCalledWith("CH001", "detail");
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

describe("setTyping()", () => {
  test("sends typing indicator (persistent)", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("typing repeats every 8 seconds and stops after the first response", async () => {
    vi.useFakeTimers();
    try {
      const bot = makeDiscordMessagingBot();
      const { responder } = createDiscordAdapters(makeEvent(), bot);

      await responder.setTyping(true);
      expect(bot.sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(7999);
      expect(bot.sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(bot.sendTyping).toHaveBeenCalledTimes(2);
      expect(bot.sendTyping).toHaveBeenNthCalledWith(2, "CH001");

      await responder.respond("hello");
      expect(bot.postReply).toHaveBeenCalledWith("CH001", "MSG001", "hello ...");
      await vi.advanceTimersByTimeAsync(16000);
      expect(bot.sendTyping).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test("setTyping(false) stops typing and allows restart", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setTyping(true);
    await responder.setTyping(false);
    vi.clearAllMocks();
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
  });

  test("threaded: sends typing indicator", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "MSG003", thread_ts: "THREAD001" });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(false) does nothing", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent();
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setTyping(false);
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });

  test("setTyping(true) after message exists does nothing", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setTyping(true);
    vi.clearAllMocks();
    await responder.setTyping(true);
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });

  test("event: sends typing indicator", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ text: "run deploy" });
    const { responder } = createDiscordAdapters(event, bot, true);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    expect(bot.postReply).not.toHaveBeenCalled();
  });
});

describe("setWorking()", () => {
  test("respond() while working appends indicator", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("content");
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted).toContain(" ...");
  });

  test("setWorking(false) removes indicator on update", async () => {
    const bot = makeDiscordMessagingBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("content");
    await responder.setWorking(false);
    const updateCall = vi.mocked(bot.updateMessageRaw).mock.calls[0];
    expect(updateCall[2]).not.toContain(" ...");
    expect(updateCall[2]).toContain("content");
  });
});

describe("replaceResponse()", () => {
  test("replaces accumulated text entirely", async () => {
    const bot = makeDiscordMessagingBot({ postReply: vi.fn().mockResolvedValue("REPLY001") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("original text");
    await responder.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessageRaw).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });
});

describe("text splitting", () => {
  test("text past the Components V2 ceiling is split", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("x".repeat(DISCORD_V2_TEXT_LIMIT + 200));
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted.length).toBeLessThanOrEqual(DISCORD_V2_TEXT_LIMIT);
    expect(posted).toContain("continued");
    expect(bot.postReply).toHaveBeenCalledTimes(2);
  });

  test("text exactly at 1900 chars is not split when not working", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setWorking(false);
    await responder.respond("x".repeat(1900));
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted.length).toBe(1900);
    expect(posted).not.toContain("continued");
    expect(bot.postReply).toHaveBeenCalledTimes(1);
  });

  test("text just past the ceiling is split", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("x".repeat(DISCORD_V2_TEXT_LIMIT - 99));
    const posted = vi.mocked(bot.postReply).mock.calls[0][2] as string;
    expect(posted.length).toBeLessThanOrEqual(DISCORD_V2_TEXT_LIMIT);
    expect(posted).toContain("continued");
    expect(bot.postReply).toHaveBeenCalledTimes(2);
  });
});

describe("deleteResponse()", () => {
  test("deletes main message", async () => {
    const bot = makeDiscordMessagingBot({
      postReply: vi.fn().mockResolvedValue("MAIN_MSG"),
      postInThread: vi.fn().mockResolvedValue("THREAD_MSG"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.respond("main");
    await responder.deleteResponse();
    expect(bot.deleteMessageRaw).toHaveBeenCalledWith("CH001", "MAIN_MSG");
    expect(bot.deleteMessageRaw).toHaveBeenCalledTimes(1);
  });

  test("does nothing if no message was created", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent();
    const { responder } = createDiscordAdapters(event, bot);
    await responder.deleteResponse();
    expect(bot.deleteMessageRaw).not.toHaveBeenCalled();
  });
});

describe("platform info", () => {
  test("name is 'discord'", () => {
    const { platform } = createDiscordAdapters(makeEvent(), makeDiscordMessagingBot());
    expect(platform.name).toBe("discord");
  });

  test("formattingGuide mentions markdown syntax", () => {
    const { platform } = createDiscordAdapters(makeEvent(), makeDiscordMessagingBot());
    expect(platform.formattingGuide).toContain("**");
  });

  test("does not show usage summary diagnostics", () => {
    const { platform } = createDiscordAdapters(makeEvent(), makeDiscordMessagingBot());
    expect(platform.diagnostics?.showUsageSummary).not.toBe(true);
  });

  test("channels and users come from DiscordMessagingBot", () => {
    const bot = makeDiscordMessagingBot({
      getAllChannels: vi.fn().mockReturnValue([{ id: "CH001", name: "general" }]),
      getAllUsers: vi
        .fn()
        .mockReturnValue([{ id: "U001", userName: "alice", displayName: "Alice" }]),
    });
    const { platform } = createDiscordAdapters(makeEvent(), bot);
    expect(platform.channels).toEqual([{ id: "CH001", name: "general" }]);
    expect(platform.users).toEqual([{ id: "U001", userName: "alice", displayName: "Alice" }]);
  });
});

describe("uploadFile()", () => {
  test("calls bot.uploadFile with channel, path, and title", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.uploadFile("/path/to/file.txt", "My File");
    expect(bot.uploadFile).toHaveBeenCalledWith("CH001", "/path/to/file.txt", "My File");
  });

  test("calls bot.uploadFile without title", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.uploadFile("/path/to/image.png");
    expect(bot.uploadFile).toHaveBeenCalledWith("CH001", "/path/to/image.png", undefined);
  });
});

describe("streaming lifecycle", () => {
  test("delta streaming posts then updates the same message", async () => {
    vi.useFakeTimers();
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);

    await responder.appendResponseDelta?.("hello");
    vi.advanceTimersByTime(2000);
    await responder.appendResponseDelta?.(" world".repeat(20));
    await responder.finishResponse?.("hello final");
    vi.useRealTimers();

    expect(bot.postReply).toHaveBeenCalledWith("CH001", "MSG001", expect.stringContaining("hello"));
    expect(bot.updateMessageRaw).toHaveBeenCalledWith(
      "CH001",
      "MSG002",
      expect.stringContaining("world"),
    );
    expect(bot.updateMessageRaw).toHaveBeenLastCalledWith("CH001", "MSG002", "hello final");
  });
});

describe("message fields", () => {
  test("userId and userName are populated from event", () => {
    const event = makeEvent({ user: "U999", userName: "bob" });
    const { message } = createDiscordAdapters(event, makeDiscordMessagingBot());
    expect(message.userId).toBe("U999");
    expect(message.userName).toBe("bob");
  });

  test("text matches event.text", () => {
    const event = makeEvent({ text: "what is 2+2?" });
    const { message } = createDiscordAdapters(event, makeDiscordMessagingBot());
    expect(message.text).toBe("what is 2+2?");
  });

  test("attachments are populated from event", () => {
    const attachments = [{ name: "file.txt", localPath: "/tmp/file.txt" }];
    const event = makeEvent({ attachments });
    const { message } = createDiscordAdapters(event, makeDiscordMessagingBot());
    expect(message.attachments).toEqual(attachments);
  });
});
