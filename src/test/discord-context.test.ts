import { describe, expect, test, vi } from "vitest";
import { DiscordMessagingBot } from "../adapters/discord/bot.js";
import type { DiscordEvent } from "../adapters/discord/bot.js";
import { createDiscordAdapters } from "../adapters/discord/context.js";
import { DISCORD_V2_TEXT_LIMIT } from "../adapters/discord/components.js";

// ============================================================================
// Minimal DiscordMessagingBot mock
// ============================================================================

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
    logBotResponse: vi.fn(),
    getAllChannels: vi.fn().mockReturnValue([]),
    getAllUsers: vi.fn().mockReturnValue([]),
    // MessagingBot interface stubs
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
    conversationId: "CH001",
    conversationKind: "shared",
    ts: "MSG001",
    user: "U001",
    text: "hello",
    ...overrides,
  };
}

// ============================================================================
// subagent progress
// ============================================================================

describe("subagent dashboard", () => {
  test("does not override the harness's response-source dashboard", () => {
    const bot = makeDiscordMessagingBot();
    const { responder } = createDiscordAdapters(makeEvent(), bot);
    // Discord speaks Markdown, so the harness-composed dashboard flows through
    // replaceResponse like any response; only a non-Markdown pipeline
    // (Telegram HTML) overrides.
    expect(responder.replaceSubagentProgress).toBeUndefined();
  });
});

// ============================================================================
// Session key derivation
// ============================================================================

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

// ============================================================================
// respond() routing
// ============================================================================

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
    const { responder } = createDiscordAdapters(event, bot, /* isEvent= */ true);
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

// ============================================================================
// respondDiagnostic()
// ============================================================================

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
    const { responder } = createDiscordAdapters(event, bot, /* isEvent= */ true);
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
    const { responder } = createDiscordAdapters(event, bot, /* isEvent= */ true);
    await responder.respondDiagnostic("detail");
    expect(bot.postMessage).toHaveBeenCalledWith("CH001", "detail");
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  // Discord uses persistent typing indicator interval, no initial message
  test("sends typing indicator (persistent)", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ ts: "MSG001", thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    // Does NOT post initial message - that's done on first respond()
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("setTyping(false) stops typing and allows restart", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    // Start typing
    await responder.setTyping(true);
    // Stop typing (should clear interval internally)
    await responder.setTyping(false);
    vi.clearAllMocks();
    // Start typing again - should call sendTyping (interval was cleared)
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
    await responder.setTyping(true); // creates message
    vi.clearAllMocks();
    await responder.setTyping(true); // should be no-op
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });

  test("event: sends typing indicator", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ text: "run deploy" });
    const { responder } = createDiscordAdapters(event, bot, /* isEvent= */ true);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith("CH001");
    // Does NOT post initial message
    expect(bot.postReply).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setWorking()
// ============================================================================

describe("setWorking()", () => {
  test("respond() while working appends indicator", async () => {
    const bot = makeDiscordMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createDiscordAdapters(event, bot);
    // Default isWorking=true
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

// ============================================================================
// replaceResponse()
// ============================================================================

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

// ============================================================================
// Text splitting
// ============================================================================

describe("text splitting", () => {
  /**
   * Components V2 allows 4000 characters across a message's text against 2000
   * for classic content, which is the reason for using it — an answer that
   * used to arrive as a string of "(continued N)" posts now fits in half as
   * many. It is still a ceiling, not its removal.
   */
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

  test("what classic content would have split now fits one message", () => {
    // The old ceiling was 1900; anything above it cost a second post.
    expect(DISCORD_V2_TEXT_LIMIT - 100).toBeGreaterThan(1900);
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

// ============================================================================
// deleteResponse()
// ============================================================================

describe("deleteResponse()", () => {
  // Discord threads not used here — only deletes main message
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

// ============================================================================
// MessagingInfo
// ============================================================================

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

// ============================================================================
// uploadFile()
// ============================================================================

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

// ============================================================================
// Streaming lifecycle
// ============================================================================

describe("streaming lifecycle", () => {
  test("delta streaming posts then updates the same message", async () => {
    // Redraws are paced by wall clock, and the renderer captures `Date.now`
    // when it is built — so the fake clock has to be in place first.
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

// ============================================================================
// ConversationMessage fields
// ============================================================================

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
