import { describe, expect, test, vi } from "vitest";
import type { SlackMessagingBot, SlackEvent } from "../src/adapters/slack/bot.js";
import { createSlackAdapters } from "../src/adapters/slack/context.js";

// ============================================================================
// Minimal SlackMessagingBot mock
// ============================================================================

function makeSlackMessagingBot(overrides: Partial<SlackMessagingBot> = {}): SlackMessagingBot {
  return {
    getUser: vi.fn().mockReturnValue(undefined),
    getAllChannels: vi.fn().mockReturnValue([]),
    getAllUsers: vi.fn().mockReturnValue([]),
    postMessage: vi.fn().mockResolvedValue("T001"),
    postInThread: vi.fn().mockResolvedValue("T002"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    startMessageStream: vi.fn().mockRejectedValue(new Error("streaming unsupported in mock")),
    appendMessageStream: vi.fn().mockResolvedValue(undefined),
    stopMessageStream: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    getChannel: vi.fn().mockReturnValue(undefined),
    enqueueEvent: vi.fn().mockReturnValue(true),
    logToFile: vi.fn(),
    ...overrides,
  } as unknown as SlackMessagingBot;
}

function makeEvent(overrides: Partial<SlackEvent> = {}): SlackEvent {
  const { channel: overrideChannel, conversationId: overrideConversationId, ...rest } = overrides;
  const channel = overrideChannel ?? "C001";
  return {
    type: "mention",
    channel,
    conversationId: overrideConversationId ?? channel,
    conversationKind: channel.startsWith("D") ? "direct" : "shared",
    ts: "1000.0001",
    user: "U001",
    text: "hello",
    ...rest,
  };
}

// ============================================================================
// Session key derivation
// ============================================================================

describe("session key derivation", () => {
  test("top-level mention uses persistent channel session", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    const bot = makeSlackMessagingBot();
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("C001");
  });

  test("thread reply uses isolated per-thread session", () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("different threads produce different session keys", () => {
    const event1 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const event2 = makeEvent({ ts: "1000.0006", thread_ts: "1000.0004" });
    const { message: m1 } = createSlackAdapters(event1, makeSlackMessagingBot());
    const { message: m2 } = createSlackAdapters(event2, makeSlackMessagingBot());
    expect(m1.sessionKey).toBe("C001:1000.0001");
    expect(m2.sessionKey).toBe("C001:1000.0004");
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
  });

  test("message id is always event.ts (not thread_ts)", () => {
    const event = makeEvent({ ts: "1000.0005", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, makeSlackMessagingBot());
    expect(message.id).toBe("1000.0005");
  });
});

// ============================================================================
// respond() routing
// ============================================================================

describe("respond() — non-threaded", () => {
  test("first call posts top-level in the channel", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("event anchor session updates that top-level message", async () => {
    const bot = makeSlackMessagingBot({ updateMessage: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({
      ts: "event:deploy-reminder.json",
      text: "Deploy now",
      thread_ts: undefined,
      sessionKey: "C001:T001",
    });
    const { message, responder } = createSlackAdapters(event, bot, {
      initialMessageTs: "T001",
    });

    expect(message.sessionKey).toBe("C001:T001");

    await responder.respond("done");

    expect(bot.updateMessage).toHaveBeenCalledWith("C001", "T001", expect.stringContaining("done"));
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("event-file-shaped ts in a Slack thread replies inside the original thread", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({
      ts: "event:deploy-reminder.json",
      text: "Deploy now",
      thread_ts: "1000.0001",
    });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("done");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("done"),
    );
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeSlackMessagingBot({ postMessage: vi.fn().mockResolvedValue("MSG1") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("first");
    await responder.respond("second");
    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "MSG1",
      expect.stringContaining("second"),
    );
  });

  test("event-file-shaped ts without a Slack ts posts a normal channel message first", async () => {
    const bot = makeSlackMessagingBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("default top-level reply mode uses chat.update streaming", async () => {
    const bot = makeSlackMessagingBot({
      postMessage: vi.fn().mockResolvedValue("MSG1"),
      startMessageStream: vi.fn().mockResolvedValue("STREAM1"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);

    await responder.appendResponseDelta?.("first");
    await responder.appendResponseDelta?.(" second".repeat(20));
    await responder.finishResponse?.("final");

    expect(bot.startMessageStream).not.toHaveBeenCalled();
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("first"));
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "MSG1",
      expect.stringContaining("second"),
    );
    expect(bot.updateMessage).toHaveBeenLastCalledWith("C001", "MSG1", "final");
    expect(bot.logBotResponse).toHaveBeenCalledTimes(1);
    expect(bot.logBotResponse).toHaveBeenCalledWith("C001", "final", "MSG1", undefined);
  });

  test("thread reply mode streams top-level inputs in the user message thread", async () => {
    const bot = makeSlackMessagingBot({
      startMessageStream: vi.fn().mockResolvedValue("STREAM1"),
      appendMessageStream: vi.fn().mockResolvedValue(undefined),
      stopMessageStream: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot, { replyMode: "thread" });

    const suffix = " second".repeat(20);
    await responder.appendResponseDelta?.("first");
    await responder.appendResponseDelta?.(suffix);
    await responder.finishResponse?.(`first${suffix}`);

    expect(bot.startMessageStream).toHaveBeenCalledWith("C001", "first", "1000.0001", "U001");
    expect(bot.appendMessageStream).toHaveBeenCalledTimes(1);
    expect(bot.appendMessageStream).toHaveBeenCalledWith("C001", "STREAM1", suffix);
    expect(bot.stopMessageStream).toHaveBeenCalledWith("C001", "STREAM1");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.updateMessage).not.toHaveBeenCalled();
  });
});

describe("respond() — threaded", () => {
  test("streaming stays in user's thread regardless of top-level reply mode", async () => {
    const bot = makeSlackMessagingBot({
      startMessageStream: vi.fn().mockResolvedValue("STREAM1"),
      appendMessageStream: vi.fn().mockResolvedValue(undefined),
      stopMessageStream: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot, { replyMode: "top-level" });

    await responder.appendResponseDelta?.("first");
    await responder.finishResponse?.("first");

    expect(bot.startMessageStream).toHaveBeenCalledWith("C001", "first", "1000.0001", "U001");
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("first call posts in user's thread (rootTs)", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("hello"),
    );
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("subsequent calls update the in-thread message", async () => {
    const bot = makeSlackMessagingBot({ postInThread: vi.fn().mockResolvedValue("THREAD_MSG1") });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("first");
    await responder.respond("second");
    expect(bot.postInThread).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "THREAD_MSG1",
      expect.stringContaining("second"),
    );
  });
});

// ============================================================================
// respondDiagnostic() — thread anchor
// ============================================================================

describe("respondDiagnostic()", () => {
  test("non-threaded: anchors diagnostics under the bot message when one exists", async () => {
    const bot = makeSlackMessagingBot({
      postMessage: vi.fn().mockResolvedValue("BOT_MSG"),
      postInThread: vi.fn().mockResolvedValue("THREAD_MSG"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("main");
    await responder.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "BOT_MSG",
      expect.stringContaining("detail"),
    );
  });

  test("threaded: anchors diagnostics under the bot message when one exists", async () => {
    const bot = makeSlackMessagingBot({
      postInThread: vi.fn().mockResolvedValue("BOT_THREAD_MSG"),
    });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("main");
    vi.clearAllMocks();
    await responder.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "BOT_THREAD_MSG",
      expect.stringContaining("detail"),
    );
  });

  test("non-threaded: anchors to event.ts even without a prior respond()", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    // rootTs is always available (event.ts), so respondDiagnostic posts immediately
    await responder.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("detail"),
    );
  });

  test("respondToolResult formats tool diagnostics; quiet-tool filtering is runner-level", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respondToolResult({
      toolName: "custom-tool",
      label: "list files",
      args: { label: "list files", command: "ls" },
      result: "ok",
      isError: false,
      durationMs: 1200,
    });
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("custom-tool"),
    );
  });

  test("event-file-shaped ts diagnostics anchor to the bot message after respond", async () => {
    const postInThread = vi.fn().mockResolvedValue("THREAD_MSG");
    const bot = makeSlackMessagingBot({
      postMessage: vi.fn().mockResolvedValue("BOT_MSG"),
      postInThread,
    });
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("main");
    await responder.respondDiagnostic("detail");
    expect(postInThread).toHaveBeenCalledWith("C001", "BOT_MSG", expect.stringContaining("detail"));
  });

  test("event-file-shaped ts diagnostics before a main response are dropped instead of using invalid thread_ts", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respondDiagnostic("detail");
    expect(bot.postInThread).not.toHaveBeenCalled();
    expect(bot.postMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  test("non-threaded: sets assistant status only", async () => {
    const bot = makeSlackMessagingBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("event-file-shaped ts does not call assistant status with invalid ts", async () => {
    const bot = makeSlackMessagingBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.setAssistantStatus).not.toHaveBeenCalled();
  });

  test("threaded: sets assistant status only", async () => {
    const bot = makeSlackMessagingBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(false) does nothing", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent();
    const { responder } = createSlackAdapters(event, bot);
    await responder.setTyping(false);
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(true) after message exists does nothing", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.setTyping(true); // creates message
    vi.clearAllMocks();
    await responder.setTyping(true); // should be no-op
    expect(bot.postMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Text accumulation and truncation
// ============================================================================

describe("setWorking()", () => {
  test("setWorking(false) before first respond omits indicator and still replies top-level", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);

    await responder.setWorking(false);
    await responder.respond("login link");

    expect(bot.postMessage).toHaveBeenCalledWith("C001", "login link");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Text accumulation and truncation
// ============================================================================

describe("text accumulation", () => {
  test("multiple respond() calls accumulate text with newlines", async () => {
    const bot = makeSlackMessagingBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("line1");
    await responder.respond("line2");
    // Second call should update with accumulated text
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).toContain("line1");
    expect(updateCall[2]).toContain("line2");
  });

  test("replaceResponse() replaces accumulated text entirely", async () => {
    const bot = makeSlackMessagingBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("original text");
    await responder.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });

  test("text is truncated at 35K chars with truncation note", async () => {
    const bot = makeSlackMessagingBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    const longText = "x".repeat(36000);
    await responder.respond(longText);
    const postedText = vi.mocked(bot.postMessage).mock.calls[0][1] as string;
    expect(postedText.length).toBeLessThan(36000);
    expect(postedText).toContain("message truncated");
  });

  test("replaceResponse posts full text without minting an overflow link when Slack accepts it", async () => {
    const bot = makeSlackMessagingBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    const createOverflowLink = vi.fn(() => "https://portal.example/session?token=abc");
    await responder.replaceResponse("x".repeat(6000), { createOverflowLink });
    const mainText = vi.mocked(bot.postMessage).mock.calls[0][1] as string;
    expect(mainText).toContain("x".repeat(6000));
    expect(mainText).not.toContain("portal.example");
    expect(createOverflowLink).not.toHaveBeenCalled();
  });

  test("replaceResponse falls back to short text with session link when Slack says msg_too_long", async () => {
    const tooLongError = new Error("An API error occurred: msg_too_long") as Error & {
      data?: { error: string };
    };
    tooLongError.data = { error: "msg_too_long" };
    const bot = makeSlackMessagingBot({
      postMessage: vi.fn().mockRejectedValueOnce(tooLongError).mockResolvedValueOnce("BOT_MSG"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    const longText = `${"x".repeat(6000)}END`;
    const createOverflowLink = vi.fn(() => "https://portal.example/session?token=abc");
    await responder.replaceResponse(longText, { createOverflowLink });
    expect(bot.postMessage).toHaveBeenCalledTimes(2);
    expect(createOverflowLink).toHaveBeenCalledTimes(1);
    const fallbackText = vi.mocked(bot.postMessage).mock.calls[1][1] as string;
    expect(fallbackText).toContain("message too long for Slack");
    expect(fallbackText).toContain("<https://portal.example/session?token=abc|open>");
    expect(fallbackText).not.toContain("END");
  });

  test("respond falls back to short text when Slack says msg_too_long", async () => {
    const tooLongError = new Error("An API error occurred: msg_too_long") as Error & {
      data?: { error: string };
    };
    tooLongError.data = { error: "msg_too_long" };
    const bot = makeSlackMessagingBot({
      postMessage: vi.fn().mockRejectedValueOnce(tooLongError).mockResolvedValueOnce("BOT_MSG"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond(`${"x".repeat(6000)}END`);
    expect(bot.postMessage).toHaveBeenCalledTimes(2);
    const fallbackText = vi.mocked(bot.postMessage).mock.calls[1][1] as string;
    expect(fallbackText).toContain("message too long for Slack");
    expect(fallbackText).not.toContain("END");
  });
});

// ============================================================================
// deleteResponse()
// ============================================================================

describe("deleteResponse()", () => {
  test("deletes main message and all thread messages", async () => {
    const bot = makeSlackMessagingBot({
      postMessage: vi.fn().mockResolvedValue("MAIN"),
      postInThread: vi.fn().mockResolvedValueOnce("THREAD1"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respond("main");
    await responder.respondDiagnostic("detail");
    await responder.deleteResponse();
    expect(bot.deleteMessage).toHaveBeenCalledWith("C001", "THREAD1");
    expect(bot.deleteMessage).toHaveBeenCalledWith("C001", "MAIN");
  });

  test("does nothing if no message was created", async () => {
    const bot = makeSlackMessagingBot();
    const event = makeEvent();
    const { responder } = createSlackAdapters(event, bot);
    await responder.deleteResponse();
    expect(bot.deleteMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// MessagingInfo
// ============================================================================

describe("platform info", () => {
  test("name is 'slack'", () => {
    const { platform } = createSlackAdapters(makeEvent(), makeSlackMessagingBot());
    expect(platform.name).toBe("slack");
  });

  test("opts in to usage summary diagnostics", () => {
    const { platform } = createSlackAdapters(makeEvent(), makeSlackMessagingBot());
    expect(platform.diagnostics?.showUsageSummary).toBe(true);
  });

  test("channels and users come from SlackMessagingBot", () => {
    const bot = makeSlackMessagingBot({
      getAllChannels: vi.fn().mockReturnValue([{ id: "C001", name: "general" }]),
      getAllUsers: vi
        .fn()
        .mockReturnValue([{ id: "U001", userName: "alice", displayName: "Alice" }]),
    });
    const { platform } = createSlackAdapters(makeEvent(), bot);
    expect(platform.channels).toEqual([{ id: "C001", name: "general" }]);
    expect(platform.users).toEqual([{ id: "U001", userName: "alice", displayName: "Alice" }]);
  });
});

// ============================================================================
// Cross-thread isolation (Phase 1: 高優先級)
// ============================================================================

describe("cross-channel isolation", () => {
  test("top-level mentions in same channel share channel session, thread replies are isolated", () => {
    const topLevel = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    const threadReply = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const bot = makeSlackMessagingBot();
    expect(createSlackAdapters(topLevel, bot).message.sessionKey).toBe("C001");
    expect(createSlackAdapters(threadReply, bot).message.sessionKey).toBe("C001:1000.0001");
  });
});

// ============================================================================
// Same-thread multi-round follow-up (Phase 1: 高優先級)
// ============================================================================

describe("same-thread multi-round follow-up", () => {
  test("subsequent message in same thread should preserve rootTs", () => {
    const event1 = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001", text: "first" });
    const event2 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001", text: "second" });
    const bot = makeSlackMessagingBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).toBe(msg2.sessionKey);
  });

  test("respondDiagnostic uses correct rootTs for same-thread follow-up", async () => {
    const bot = makeSlackMessagingBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respondDiagnostic("reply");
    expect(bot.postInThread).toHaveBeenCalledWith("C001", "1000.0001", expect.any(String));
  });

  test("multiple respondDiagnostic calls should all go to same thread", async () => {
    const bot = makeSlackMessagingBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.respondDiagnostic("reply 1");
    await responder.respondDiagnostic("reply 2");
    await responder.respondDiagnostic("reply 3");
    expect(bot.postInThread).toHaveBeenCalledTimes(3);
    // All calls should use same rootTs
    expect(bot.postInThread).toHaveBeenCalledWith("C001", "1000.0001", expect.any(String));
  });
});

// ============================================================================
// thread_ts boundary values (Phase 1: 高優先級)
// ============================================================================

describe("thread_ts boundary values", () => {
  test("no thread_ts → bare channelId session", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: undefined });
    expect(createSlackAdapters(event, makeSlackMessagingBot()).message.sessionKey).toBe("C001");
  });

  test("with thread_ts → channelId:thread_ts session", () => {
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    expect(createSlackAdapters(event, makeSlackMessagingBot()).message.sessionKey).toBe(
      "C001:1000.0001",
    );
  });

  test("empty string thread_ts is treated as no thread (falsy)", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: "" });
    expect(createSlackAdapters(event, makeSlackMessagingBot()).message.sessionKey).toBe("C001");
  });

  test("DM top-level messages share a single persistent session", () => {
    const event1 = makeEvent({ channel: "D001", ts: "1000.0001", thread_ts: undefined });
    const event2 = makeEvent({ channel: "D001", ts: "1000.0002", thread_ts: undefined });
    const bot = makeSlackMessagingBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).toBe("D001");
    expect(msg2.sessionKey).toBe("D001");
  });

  test("DM thread replies use isolated per-thread sessions", () => {
    const event = makeEvent({
      channel: "D001",
      ts: "1000.0003",
      thread_ts: "1000.0001",
    });
    const bot = makeSlackMessagingBot();
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("D001:1000.0001");
  });

  test("setTyping in thread should set assistant status with correct rootTs", async () => {
    const bot = makeSlackMessagingBot({
      setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
  });

  test("uploadFile in thread should use correct rootTs", async () => {
    const bot = makeSlackMessagingBot({
      uploadFile: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responder } = createSlackAdapters(event, bot);
    await responder.uploadFile("/path/to/file.txt", "test");
    expect(bot.uploadFile).toHaveBeenCalledWith("C001", "/path/to/file.txt", "test", "1000.0001");
  });
});

describe("streaming lifecycle", () => {
  test("thread reply mode native stream failure falls back to incremental chat.update", async () => {
    const bot = makeSlackMessagingBot({
      startMessageStream: vi.fn().mockRejectedValue(new Error("missing required field: thread_ts")),
      postMessage: vi.fn().mockResolvedValue("T001"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot, { replyMode: "thread" });

    await responder.appendResponseDelta?.("hello");
    await responder.appendResponseDelta?.(" world".repeat(20));
    await responder.finishResponse?.("hello final");

    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("hello"),
    );
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "T002",
      expect.stringContaining("world"),
    );
    expect(bot.updateMessage).toHaveBeenLastCalledWith("C001", "T002", "hello final");
  });

  test("native stream append conflict abandons the stream message before fallback", async () => {
    const bot = makeSlackMessagingBot({
      startMessageStream: vi.fn().mockResolvedValue("STREAM1"),
      appendMessageStream: vi
        .fn()
        .mockRejectedValue(new Error("An API error occurred: streaming_state_conflict")),
      stopMessageStream: vi.fn().mockResolvedValue(undefined),
      postInThread: vi.fn().mockResolvedValue("FALLBACK1"),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createSlackAdapters(event, bot, { replyMode: "thread" });

    await responder.appendResponseDelta?.("hello");
    await responder.appendResponseDelta?.(" world");
    await responder.finishResponse?.("hello world");

    expect(bot.stopMessageStream).toHaveBeenCalledWith("C001", "STREAM1");
    expect(bot.updateMessage).not.toHaveBeenCalledWith("C001", "STREAM1", expect.any(String));
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("hello world"),
    );
    expect(bot.updateMessage).not.toHaveBeenCalled();
  });
});
