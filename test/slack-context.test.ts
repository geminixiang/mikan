import { describe, expect, test, vi } from "vitest";
import { ErrorCode } from "@slack/web-api";
import type { SlackBot, SlackEvent } from "../src/adapters/slack/bot.js";
import { createSlackAdapters } from "../src/adapters/slack/context.js";

// ============================================================================
// Minimal SlackBot mock
// ============================================================================

function makeSlackBot(overrides: Partial<SlackBot> = {}): SlackBot {
  return {
    getUser: vi.fn().mockReturnValue(undefined),
    getAllChannels: vi.fn().mockReturnValue([]),
    getAllUsers: vi.fn().mockReturnValue([]),
    postMessage: vi.fn().mockResolvedValue("T001"),
    postInThread: vi.fn().mockResolvedValue("T002"),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    aliasSyntheticEventThread: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    getChannel: vi.fn().mockReturnValue(undefined),
    enqueueEvent: vi.fn().mockReturnValue(true),
    logToFile: vi.fn(),
    ...overrides,
  } as unknown as SlackBot;
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
    const bot = makeSlackBot();
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("C001");
  });

  test("thread reply uses isolated per-thread session", () => {
    const bot = makeSlackBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("C001:1000.0001");
  });

  test("different threads produce different session keys", () => {
    const event1 = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const event2 = makeEvent({ ts: "1000.0006", thread_ts: "1000.0004" });
    const { message: m1 } = createSlackAdapters(event1, makeSlackBot());
    const { message: m2 } = createSlackAdapters(event2, makeSlackBot());
    expect(m1.sessionKey).toBe("C001:1000.0001");
    expect(m2.sessionKey).toBe("C001:1000.0004");
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
  });

  test("message id is always event.ts (not thread_ts)", () => {
    const event = makeEvent({ ts: "1000.0005", thread_ts: "1000.0001" });
    const { message } = createSlackAdapters(event, makeSlackBot());
    expect(message.id).toBe("1000.0005");
  });
});

// ============================================================================
// respond() routing
// ============================================================================

describe("respond() — non-threaded", () => {
  test("first call posts top-level in the channel", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("falls back to a short session-link reply when Slack rejects a too-long message", async () => {
    const tooLongError = Object.assign(new Error("msg_too_long"), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: "msg_too_long" },
    });
    const bot = makeSlackBot({
      postMessage: vi.fn().mockRejectedValueOnce(tooLongError).mockResolvedValueOnce("T001"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot, false, {
      getSessionViewUrl: () => "https://portal.example/session?token=tok-session",
    });

    await responseCtx.respond(`hello\n\n${"detail ".repeat(1000)}`);

    expect(bot.postMessage).toHaveBeenCalledTimes(2);
    expect(bot.postMessage).toHaveBeenNthCalledWith(1, "C001", expect.stringContaining("detail"));
    expect(bot.postMessage).toHaveBeenNthCalledWith(
      2,
      "C001",
      expect.stringContaining("https://portal.example/session?token=tok-session"),
    );
  });

  test("synthetic event posts top-level instead of using an invalid thread root", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({
      ts: "event:deploy-reminder.json",
      text: "Deploy now",
      thread_ts: undefined,
    });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.respond("done");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("done"));
    expect(bot.postInThread).not.toHaveBeenCalled();
    expect((bot as any).aliasSyntheticEventThread).toHaveBeenCalledWith(
      "C001",
      "T001",
      "event:deploy-reminder.json",
    );
  });

  test("synthetic event in a Slack thread replies inside the original thread", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({
      ts: "event:deploy-reminder.json",
      text: "Deploy now",
      thread_ts: "1000.0001",
    });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.respond("done");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("done"),
    );
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG1") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
    expect(bot.postMessage).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "C001",
      "MSG1",
      expect.stringContaining("second"),
    );
  });

  test("synthetic events without a Slack ts post a normal channel message first", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("BOT_MSG") });
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.respond("hello");
    expect(bot.postMessage).toHaveBeenCalledWith("C001", expect.stringContaining("hello"));
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

describe("respond() — threaded", () => {
  test("first call posts in user's thread (rootTs)", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("hello");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("hello"),
    );
    expect(bot.postMessage).not.toHaveBeenCalled();
  });

  test("subsequent calls update the in-thread message", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("THREAD_MSG1") });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("first");
    await responseCtx.respond("second");
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
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("BOT_MSG"),
      postInThread: vi.fn().mockResolvedValue("THREAD_MSG"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "BOT_MSG",
      expect.stringContaining("detail"),
    );
  });

  test("threaded: anchors diagnostics under the bot message when one exists", async () => {
    const bot = makeSlackBot({ postInThread: vi.fn().mockResolvedValue("BOT_THREAD_MSG") });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("main");
    vi.clearAllMocks();
    await responseCtx.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "BOT_THREAD_MSG",
      expect.stringContaining("detail"),
    );
  });

  test("non-threaded: anchors to event.ts even without a prior respond()", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    // rootTs is always available (event.ts), so respondDiagnostic posts immediately
    await responseCtx.respondDiagnostic("detail");
    expect(bot.postInThread).toHaveBeenCalledWith(
      "C001",
      "1000.0001",
      expect.stringContaining("detail"),
    );
  });

  test("respondToolResult formats tool diagnostics; quiet-tool filtering is runner-level", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondToolResult({
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

  test("synthetic event diagnostics anchor to the bot message after respond", async () => {
    const postInThread = vi.fn().mockResolvedValue("THREAD_MSG");
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("BOT_MSG"),
      postInThread,
    });
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.respond("main");
    await responseCtx.respondDiagnostic("detail");
    expect(postInThread).toHaveBeenCalledWith("C001", "BOT_MSG", expect.stringContaining("detail"));
  });

  test("synthetic event diagnostics before a main response are dropped instead of using invalid thread_ts", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.respondDiagnostic("detail");
    expect(bot.postInThread).not.toHaveBeenCalled();
    expect(bot.postMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  test("non-threaded: sets assistant status only", async () => {
    const bot = makeSlackBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("synthetic events do not call assistant status with invalid ts", async () => {
    const bot = makeSlackBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ ts: "event:reminder.json" });
    const { responseCtx } = createSlackAdapters(event, bot, true);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).not.toHaveBeenCalled();
  });

  test("threaded: sets assistant status only", async () => {
    const bot = makeSlackBot({ setAssistantStatus: vi.fn().mockResolvedValue(undefined) });
    const event = makeEvent({ ts: "1000.0003", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(false) does nothing", async () => {
    const bot = makeSlackBot();
    const event = makeEvent();
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(false);
    expect(bot.postMessage).not.toHaveBeenCalled();
    expect(bot.postInThread).not.toHaveBeenCalled();
  });

  test("setTyping(true) after message exists does nothing", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true); // creates message
    vi.clearAllMocks();
    await responseCtx.setTyping(true); // should be no-op
    expect(bot.postMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Text accumulation and truncation
// ============================================================================

describe("setWorking()", () => {
  test("setWorking(false) before first respond omits indicator and still replies top-level", async () => {
    const bot = makeSlackBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);

    await responseCtx.setWorking(false);
    await responseCtx.respond("login link");

    expect(bot.postMessage).toHaveBeenCalledWith("C001", "login link");
    expect(bot.postInThread).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Text accumulation and truncation
// ============================================================================

describe("text accumulation", () => {
  test("multiple respond() calls accumulate text with newlines", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("line1");
    await responseCtx.respond("line2");
    // Second call should update with accumulated text
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).toContain("line1");
    expect(updateCall[2]).toContain("line2");
  });

  test("replaceResponse() replaces accumulated text entirely", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("original text");
    await responseCtx.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });

  test("text is truncated at 35K chars with truncation note", async () => {
    const bot = makeSlackBot({ postMessage: vi.fn().mockResolvedValue("MSG") });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    const longText = "x".repeat(36000);
    await responseCtx.respond(longText);
    const postedText = vi.mocked(bot.postMessage).mock.calls[0][1] as string;
    expect(postedText.length).toBeLessThan(36000);
    expect(postedText).toContain("message truncated");
  });

  test("replaceResponse posts long final text to diagnostics under the bot message", async () => {
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("BOT_MSG"),
      postInThread: vi.fn().mockResolvedValue("THREAD_MSG"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    const longText = `${"x".repeat(35900)}END`;
    await responseCtx.replaceResponse(longText);
    expect(bot.postMessage).toHaveBeenNthCalledWith(
      1,
      "C001",
      expect.stringContaining("see thread for full response"),
    );
    expect(bot.postInThread).toHaveBeenCalledTimes(2);
    expect(bot.postInThread).toHaveBeenNthCalledWith(
      2,
      "C001",
      "BOT_MSG",
      expect.stringContaining("END"),
    );
  });
});

// ============================================================================
// deleteResponse()
// ============================================================================

describe("deleteResponse()", () => {
  test("deletes main message and all thread messages", async () => {
    const bot = makeSlackBot({
      postMessage: vi.fn().mockResolvedValue("MAIN"),
      postInThread: vi.fn().mockResolvedValueOnce("THREAD1"),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respond("main");
    await responseCtx.respondDiagnostic("detail");
    await responseCtx.deleteResponse();
    expect(bot.deleteMessage).toHaveBeenCalledWith("C001", "THREAD1");
    expect(bot.deleteMessage).toHaveBeenCalledWith("C001", "MAIN");
  });

  test("does nothing if no message was created", async () => {
    const bot = makeSlackBot();
    const event = makeEvent();
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.deleteResponse();
    expect(bot.deleteMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PlatformInfo
// ============================================================================

describe("platform info", () => {
  test("name is 'slack'", () => {
    const { platform } = createSlackAdapters(makeEvent(), makeSlackBot());
    expect(platform.name).toBe("slack");
  });

  test("opts in to usage summary diagnostics", () => {
    const { platform } = createSlackAdapters(makeEvent(), makeSlackBot());
    expect(platform.diagnostics?.showUsageSummary).toBe(true);
  });

  test("channels and users come from SlackBot", () => {
    const bot = makeSlackBot({
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
    const bot = makeSlackBot();
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
    const bot = makeSlackBot();
    const { message: msg1 } = createSlackAdapters(event1, bot);
    const { message: msg2 } = createSlackAdapters(event2, bot);
    expect(msg1.sessionKey).toBe(msg2.sessionKey);
  });

  test("respondDiagnostic uses correct rootTs for same-thread follow-up", async () => {
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondDiagnostic("reply");
    expect(bot.postInThread).toHaveBeenCalledWith("C001", "1000.0001", expect.any(String));
  });

  test("multiple respondDiagnostic calls should all go to same thread", async () => {
    const bot = makeSlackBot({
      postInThread: vi.fn().mockResolvedValue("T002"),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.respondDiagnostic("reply 1");
    await responseCtx.respondDiagnostic("reply 2");
    await responseCtx.respondDiagnostic("reply 3");
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
    expect(createSlackAdapters(event, makeSlackBot()).message.sessionKey).toBe("C001");
  });

  test("with thread_ts → channelId:thread_ts session", () => {
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    expect(createSlackAdapters(event, makeSlackBot()).message.sessionKey).toBe("C001:1000.0001");
  });

  test("empty string thread_ts is treated as no thread (falsy)", () => {
    const event = makeEvent({ ts: "1000.0001", thread_ts: "" });
    expect(createSlackAdapters(event, makeSlackBot()).message.sessionKey).toBe("C001");
  });

  test("DM top-level messages share a single persistent session", () => {
    const event1 = makeEvent({ channel: "D001", ts: "1000.0001", thread_ts: undefined });
    const event2 = makeEvent({ channel: "D001", ts: "1000.0002", thread_ts: undefined });
    const bot = makeSlackBot();
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
    const bot = makeSlackBot();
    const { message } = createSlackAdapters(event, bot);
    expect(message.sessionKey).toBe("D001:1000.0001");
  });

  test("setTyping in thread should set assistant status with correct rootTs", async () => {
    const bot = makeSlackBot({
      setAssistantStatus: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.setTyping(true);
    expect(bot.setAssistantStatus).toHaveBeenCalledWith("C001", "1000.0001", "Thinking");
  });

  test("uploadFile in thread should use correct rootTs", async () => {
    const bot = makeSlackBot({
      uploadFile: vi.fn().mockResolvedValue(undefined),
    });
    const event = makeEvent({ ts: "1000.0002", thread_ts: "1000.0001" });
    const { responseCtx } = createSlackAdapters(event, bot);
    await responseCtx.uploadFile("/path/to/file.txt", "test");
    expect(bot.uploadFile).toHaveBeenCalledWith("C001", "/path/to/file.txt", "test", "1000.0001");
  });
});
