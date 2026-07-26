import { describe, expect, test, vi } from "vitest";
import type { SubagentProgressSnapshot } from "../src/adapter.js";
import { TelegramMessagingBot } from "../src/adapters/telegram/bot.js";
import type { TelegramEvent } from "../src/adapters/telegram/bot.js";
import { createTelegramAdapters } from "../src/adapters/telegram/context.js";

// ============================================================================
// Minimal TelegramMessagingBot mock
// ============================================================================

function makeTelegramMessagingBot(
  overrides: Partial<TelegramMessagingBot> = {},
): TelegramMessagingBot {
  return {
    postMessageRaw: vi.fn().mockResolvedValue(1001),
    postReply: vi.fn().mockResolvedValue(1002),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessageRaw: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    // MessagingBot interface stubs
    start: vi.fn(),
    postMessage: vi.fn().mockResolvedValue("1001"),
    enqueueEvent: vi.fn().mockReturnValue(true),
    getMessagingInfo: TelegramMessagingBot.prototype.getMessagingInfo,
    ...overrides,
  } as unknown as TelegramMessagingBot;
}

function makeEvent(overrides: Partial<TelegramEvent> = {}): TelegramEvent {
  return {
    type: "message",
    conversationId: "123456",
    conversationKind: "direct",
    ts: "1001",
    user: "U001",
    text: "hello",
    ...overrides,
  };
}

// ============================================================================
// subagent progress
// ============================================================================

describe("replaceSubagentProgress()", () => {
  test("renders a compact HTML dashboard in the response message", async () => {
    const bot = makeTelegramMessagingBot();
    const { responder } = createTelegramAdapters(makeEvent(), bot);
    const progress: SubagentProgressSnapshot = {
      mode: "dag",
      nodes: [
        { id: "explore", label: "Explore <auth>", status: "completed" },
        { id: "implement", label: "Implement fix", status: "running" },
      ],
    };

    await responder.replaceSubagentProgress?.(progress);

    expect(bot.postMessageRaw).toHaveBeenCalledWith(
      123456,
      expect.stringContaining("<b>Subagents · 1/2 · DAG</b>"),
    );
    expect(bot.postMessageRaw).toHaveBeenCalledWith(
      123456,
      expect.stringContaining("Explore &lt;auth&gt;\n└ Completed"),
    );
  });
});

// ============================================================================
// Session key derivation
// ============================================================================

describe("session key derivation", () => {
  test("non-threaded: sessionKey = channel:ts", () => {
    const event = makeEvent({ ts: "1001", thread_ts: undefined });
    const { message } = createTelegramAdapters(event, makeTelegramMessagingBot());
    expect(message.sessionKey).toBe("123456:1001");
  });

  test("threaded: sessionKey = channel:thread_ts", () => {
    const event = makeEvent({ ts: "1003", thread_ts: "1001" });
    const { message } = createTelegramAdapters(event, makeTelegramMessagingBot());
    expect(message.sessionKey).toBe("123456:1001");
  });

  test("message id is always event.ts", () => {
    const event = makeEvent({ ts: "1005", thread_ts: "1001" });
    const { message } = createTelegramAdapters(event, makeTelegramMessagingBot());
    expect(message.id).toBe("1005");
  });

  test("different threads in same channel produce different session keys", () => {
    const event1 = makeEvent({ ts: "1003", thread_ts: "1001" });
    const event2 = makeEvent({ ts: "1006", thread_ts: "1004" });
    const { message: m1 } = createTelegramAdapters(event1, makeTelegramMessagingBot());
    const { message: m2 } = createTelegramAdapters(event2, makeTelegramMessagingBot());
    expect(m1.sessionKey).toBe("123456:1001");
    expect(m2.sessionKey).toBe("123456:1004");
    expect(m1.sessionKey).not.toBe(m2.sessionKey);
  });
});

// ============================================================================
// respond() routing
// ============================================================================

describe("respond() — non-threaded", () => {
  test("first call posts to channel", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postMessageRaw).toHaveBeenCalledWith(123456, expect.stringContaining("hello"));
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("subsequent calls update the same message", async () => {
    const bot = makeTelegramMessagingBot({ postMessageRaw: vi.fn().mockResolvedValue(2001) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("first");
    await responder.respond("second");
    expect(bot.postMessageRaw).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "123456",
      "2001",
      expect.stringContaining("second"),
    );
  });

  test("update call accumulates text with newline", async () => {
    const bot = makeTelegramMessagingBot({ postMessageRaw: vi.fn().mockResolvedValue(2001) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("line1");
    await responder.respond("line2");
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).toContain("line1");
    expect(updateCall[2]).toContain("line2");
  });

  test("calls logBotResponse on successful respond", async () => {
    const bot = makeTelegramMessagingBot({ postMessageRaw: vi.fn().mockResolvedValue(2001) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.logBotResponse).toHaveBeenCalledWith("123456", "hello", "2001");
  });

  test("escapes unsupported HTML-like tokens but keeps Telegram tags", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("Usage: gws +read --id <ID> with <b>bold</b>");
    expect(bot.postMessageRaw).toHaveBeenCalledWith(
      123456,
      "Usage: gws +read --id &lt;ID&gt; with <b>bold</b>",
    );
  });
});

describe("respond() — threaded (reply to parent message)", () => {
  test("first call posts as reply to parent message", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ ts: "1003", thread_ts: "1001" });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("hello");
    expect(bot.postReply).toHaveBeenCalledWith(123456, 1001, expect.stringContaining("hello"));
    expect(bot.postMessageRaw).not.toHaveBeenCalled();
  });

  test("subsequent calls update the reply message", async () => {
    const bot = makeTelegramMessagingBot({ postReply: vi.fn().mockResolvedValue(3001) });
    const event = makeEvent({ ts: "1003", thread_ts: "1001" });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("first");
    await responder.respond("second");
    expect(bot.postReply).toHaveBeenCalledTimes(1);
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "123456",
      "3001",
      expect.stringContaining("second"),
    );
  });
});

// ============================================================================
// respondDiagnostic()
// ============================================================================

describe("respondDiagnostic()", () => {
  test("non-threaded: posts a regular diagnostic message", async () => {
    const bot = makeTelegramMessagingBot({ postMessageRaw: vi.fn().mockResolvedValue(2001) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("main");
    vi.clearAllMocks();
    await responder.respondDiagnostic("detail");
    expect(bot.postMessageRaw).toHaveBeenCalledWith(123456, "detail");
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("threaded: still posts diagnostics as regular chat messages", async () => {
    const bot = makeTelegramMessagingBot({ postReply: vi.fn().mockResolvedValue(3001) });
    const event = makeEvent({ ts: "1003", thread_ts: "1001" });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("main");
    vi.clearAllMocks();
    await responder.respondDiagnostic("detail");
    expect(bot.postMessageRaw).toHaveBeenCalledWith(123456, "detail");
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("non-threaded: can post before a main message exists", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respondDiagnostic("detail");
    expect(bot.postMessageRaw).toHaveBeenCalledWith(123456, "detail");
    expect(bot.postReply).not.toHaveBeenCalled();
  });

  test("respondToolResult formats and posts diagnostics", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respondToolResult({
      toolName: "bash",
      label: "list files",
      args: { label: "list files", command: "ls" },
      result: "ok",
      isError: false,
      durationMs: 1200,
    });
    expect(bot.postMessageRaw).toHaveBeenCalledWith(
      123456,
      expect.stringContaining("Done bash: list files"),
    );
  });
});

// ============================================================================
// setTyping()
// ============================================================================

describe("setTyping()", () => {
  test("sends typing action immediately", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith(123456);
    expect(bot.postMessageRaw).not.toHaveBeenCalled();
  });

  test("does not post placeholder message", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ ts: "1003", thread_ts: "1001" });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledWith(123456);
    expect(bot.postReply).not.toHaveBeenCalled();
    expect(bot.postMessageRaw).not.toHaveBeenCalled();
  });

  test("setTyping(false) does nothing if not typing", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent();
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setTyping(false);
    expect(bot.postMessageRaw).not.toHaveBeenCalled();
    expect(bot.sendTyping).not.toHaveBeenCalled();
  });

  test("setTyping(true) twice does not duplicate interval", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setTyping(true);
    await responder.setTyping(true); // should be no-op
    expect(bot.sendTyping).toHaveBeenCalledTimes(1);
  });

  test("setTyping(false) allows re-triggering", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setTyping(true);
    await responder.setTyping(false);
    vi.clearAllMocks();
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// setWorking()
// ============================================================================

describe("setWorking()", () => {
  test("setWorking(false) allows typing to be re-triggered", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setTyping(true);
    await responder.setWorking(false);
    vi.clearAllMocks();
    // After setWorking(false), typing can be started again
    await responder.setTyping(true);
    expect(bot.sendTyping).toHaveBeenCalledTimes(1);
  });

  test("respond() does not append working indicator", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("content");
    const posted = vi.mocked(bot.postMessageRaw).mock.calls[0][1] as string;
    expect(posted).toBe("content");
  });
});

// ============================================================================
// replaceResponse()
// ============================================================================

describe("replaceResponse()", () => {
  test("replaces accumulated text entirely", async () => {
    const bot = makeTelegramMessagingBot({ postMessageRaw: vi.fn().mockResolvedValue(2001) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("original text");
    await responder.replaceResponse("replacement");
    const updateCall = vi.mocked(bot.updateMessage).mock.calls[0];
    expect(updateCall[2]).not.toContain("original text");
    expect(updateCall[2]).toContain("replacement");
  });

  test("replaceResponse splits long text into continuation messages", async () => {
    const bot = makeTelegramMessagingBot({ postMessageRaw: vi.fn().mockResolvedValue(2001) });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setWorking(false);
    await responder.replaceResponse("x".repeat(4000));
    const posted = vi.mocked(bot.postMessageRaw).mock.calls[0][1] as string;
    expect(posted.length).toBeLessThanOrEqual(3800);
    expect(posted).toContain("continued");
    expect(bot.postMessageRaw).toHaveBeenCalledTimes(2);
  });

  test("replaceResponse converts HTML tables into Telegram-safe pre blocks", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.replaceResponse("<table><tr><th>Name</th></tr><tr><td>Alice</td></tr></table>");
    expect(bot.postMessageRaw).toHaveBeenCalledWith(123456, expect.stringContaining("<pre>"));
    const posted = vi.mocked(bot.postMessageRaw).mock.calls[0][1] as string;
    expect(posted).toContain("| Name  |");
    expect(posted).toContain("| Alice |");
  });
});

// ============================================================================
// Text truncation
// ============================================================================

describe("text splitting", () => {
  test("long text is split at 3800 chars", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("x".repeat(4000));
    const posted = vi.mocked(bot.postMessageRaw).mock.calls[0][1] as string;
    expect(posted.length).toBeLessThanOrEqual(3800);
    expect(posted).toContain("continued");
    expect(bot.postMessageRaw).toHaveBeenCalledTimes(2);
  });

  test("text exactly at 3800 chars is not split when not working", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.setWorking(false);
    await responder.respond("x".repeat(3800));
    const posted = vi.mocked(bot.postMessageRaw).mock.calls[0][1] as string;
    expect(posted.length).toBe(3800);
    expect(posted).not.toContain("continued");
    expect(bot.postMessageRaw).toHaveBeenCalledTimes(1);
  });

  test("text at 3801 chars is split", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("x".repeat(3801));
    const posted = vi.mocked(bot.postMessageRaw).mock.calls[0][1] as string;
    expect(posted.length).toBeLessThanOrEqual(3800);
    expect(posted).toContain("continued");
    expect(bot.postMessageRaw).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// deleteResponse()
// ============================================================================

describe("deleteResponse()", () => {
  // Telegram has no threads — only deletes main message
  test("deletes main message", async () => {
    const bot = makeTelegramMessagingBot({
      postMessageRaw: vi.fn().mockResolvedValue(2001),
      postReply: vi.fn().mockResolvedValue(3001),
    });
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.respond("main");
    await responder.deleteResponse();
    expect(bot.deleteMessageRaw).toHaveBeenCalledWith(123456, 2001);
    expect(bot.deleteMessageRaw).toHaveBeenCalledTimes(1);
  });

  test("does nothing if no message was created", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent();
    const { responder } = createTelegramAdapters(event, bot);
    await responder.deleteResponse();
    expect(bot.deleteMessageRaw).not.toHaveBeenCalled();
  });
});

// ============================================================================
// MessagingInfo
// ============================================================================

describe("platform info", () => {
  test("name is 'telegram'", () => {
    const { platform } = createTelegramAdapters(makeEvent(), makeTelegramMessagingBot());
    expect(platform.name).toBe("telegram");
  });

  test("formattingGuide mentions HTML tags", () => {
    const { platform } = createTelegramAdapters(makeEvent(), makeTelegramMessagingBot());
    expect(platform.formattingGuide).toContain("<b>");
  });

  test("does not show usage summary diagnostics", () => {
    const { platform } = createTelegramAdapters(makeEvent(), makeTelegramMessagingBot());
    expect(platform.diagnostics?.showUsageSummary).not.toBe(true);
  });

  test("channels and users are empty (Telegram has no guild registry)", () => {
    const { platform } = createTelegramAdapters(makeEvent(), makeTelegramMessagingBot());
    expect(platform.channels).toEqual([]);
    expect(platform.users).toEqual([]);
  });
});

// ============================================================================
// uploadFile()
// ============================================================================

describe("uploadFile()", () => {
  test("calls bot.uploadFile with channel, path, and title", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.uploadFile("/path/to/file.txt", "My File");
    expect(bot.uploadFile).toHaveBeenCalledWith("123456", "/path/to/file.txt", "My File");
  });

  test("calls bot.uploadFile without title", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);
    await responder.uploadFile("/path/to/image.png");
    expect(bot.uploadFile).toHaveBeenCalledWith("123456", "/path/to/image.png", undefined);
  });
});

// ============================================================================
// Streaming lifecycle
// ============================================================================

describe("streaming lifecycle", () => {
  test("delta streaming posts then updates the same message", async () => {
    const bot = makeTelegramMessagingBot();
    const event = makeEvent({ thread_ts: undefined });
    const { responder } = createTelegramAdapters(event, bot);

    await responder.appendResponseDelta?.("hello");
    await responder.appendResponseDelta?.(" world".repeat(20));
    await responder.finishResponse?.("hello final");

    expect(bot.postMessageRaw).toHaveBeenCalledWith(123456, expect.stringContaining("hello"));
    expect(bot.updateMessage).toHaveBeenCalledWith(
      "123456",
      "1001",
      expect.stringContaining("world"),
    );
    expect(bot.updateMessage).toHaveBeenLastCalledWith("123456", "1001", "hello final");
  });
});

// ============================================================================
// ConversationMessage fields
// ============================================================================

describe("message fields", () => {
  test("userId and userName are populated from event", () => {
    const event = makeEvent({ user: "U999", userName: "alice" });
    const { message } = createTelegramAdapters(event, makeTelegramMessagingBot());
    expect(message.userId).toBe("U999");
    expect(message.userName).toBe("alice");
  });

  test("text matches event.text", () => {
    const event = makeEvent({ text: "what time is it?" });
    const { message } = createTelegramAdapters(event, makeTelegramMessagingBot());
    expect(message.text).toBe("what time is it?");
  });

  test("attachments are populated from event", () => {
    const attachments = [{ name: "file.txt", localPath: "/tmp/file.txt" }];
    const event = makeEvent({ attachments });
    const { message } = createTelegramAdapters(event, makeTelegramMessagingBot());
    expect(message.attachments).toEqual(attachments);
  });
});
