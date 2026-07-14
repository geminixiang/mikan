import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as log from "../src/log.js";
import type { LogContext } from "../src/types.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

function captureConsole() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(
      args
        .map((a) => String(a))
        .join(" ")
        .replace(ANSI, ""),
    );
  });
  return { lines, spy, output: () => lines.join("\n") };
}

describe("log functions exist", () => {
  test("all expected log functions are exported", () => {
    expect(typeof log.logUserMessage).toBe("function");
    expect(typeof log.logToolStart).toBe("function");
    expect(typeof log.logToolSuccess).toBe("function");
    expect(typeof log.logToolError).toBe("function");
    expect(typeof log.logResponse).toBe("function");
    expect(typeof log.logThinking).toBe("function");
    expect(typeof log.logInfo).toBe("function");
    expect(typeof log.logWarning).toBe("function");
    expect(typeof log.logAgentError).toBe("function");
    expect(typeof log.logStartup).toBe("function");
    expect(typeof log.logConnected).toBe("function");
    expect(typeof log.logDisconnected).toBe("function");
  });
});

describe("log context formatting", () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.spy.mockRestore();
  });

  test("formats DM conversations using the user name", () => {
    const ctx: LogContext = { conversationId: "D123", userName: "alice" };
    log.logUserMessage(ctx, "hi there");
    expect(cap.output()).toContain("[DM:alice]");
    expect(cap.output()).toContain("hi there");
  });

  test("falls back to the conversation id for DMs without a user name", () => {
    log.logUserMessage({ conversationId: "D999" }, "anon");
    expect(cap.output()).toContain("[DM:D999]");
  });

  test("prefixes channel names with # and includes the session id", () => {
    const ctx: LogContext = {
      conversationId: "C1",
      conversationName: "general",
      userName: "bob",
      sessionId: "s7",
    };
    log.logUserMessage(ctx, "hello");
    expect(cap.output()).toContain("[#general:bob:s7]");
  });

  test("does not double-prefix a conversation name already starting with #", () => {
    log.logUserMessage({ conversationId: "C1", conversationName: "#ops", userName: "bob" }, "x");
    expect(cap.output()).toContain("[#ops:bob]");
    expect(cap.output()).not.toContain("##ops");
  });

  test("uses 'unknown' for a channel message without a user name", () => {
    log.logUserMessage({ conversationId: "C1", conversationName: "general" }, "x");
    expect(cap.output()).toContain("[#general:unknown]");
  });
});

describe("log tool + response output", () => {
  let cap: ReturnType<typeof captureConsole>;
  const ctx: LogContext = { conversationId: "C1", conversationName: "general", userName: "bob" };

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.spy.mockRestore();
  });

  test("logs tool start with a label and indented args", () => {
    log.logToolStart(ctx, "bash", "run tests", { command: "npm test" });
    const out = cap.output();
    expect(out).toContain("↳ bash: run tests");
    expect(out).toContain("npm test");
  });

  test("logs tool start without an args block when there are no args", () => {
    log.logToolStart(ctx, "noop", "nothing", {});
    expect(cap.lines.length).toBe(1);
    expect(cap.output()).toContain("↳ noop: nothing");
  });

  test("logs tool success with a formatted duration", () => {
    log.logToolSuccess(ctx, "bash", 1500, "ok");
    const out = cap.output();
    expect(out).toContain("✓ bash (1.5s)");
    expect(out).toContain("ok");
  });

  test("logs tool errors with the error body", () => {
    log.logToolError(ctx, "bash", 500, "boom");
    const out = cap.output();
    expect(out).toContain("✗ bash (0.5s)");
    expect(out).toContain("boom");
  });

  test("truncates long previews and notes the cut", () => {
    log.logToolSuccess(ctx, "read", 100, "x".repeat(2000));
    expect(cap.output()).toContain("(truncated at 1000 chars)");
  });

  test("logs thinking and response bodies", () => {
    log.logThinking(ctx, "pondering");
    log.logResponse(ctx, "the answer");
    const out = cap.output();
    expect(out).toContain("💭 Thinking");
    expect(out).toContain("pondering");
    expect(out).toContain("💬 Response");
    expect(out).toContain("the answer");
  });

  test("shows the model display name only when it differs from the model id", () => {
    log.logAgentRunStart(ctx, "anthropic", "claude-x", "Claude X");
    log.logAgentRunStart(ctx, "anthropic", "claude-y", "claude-y");
    const [withName, withoutName] = cap.lines;
    expect(withName).toContain("anthropic/claude-x (Claude X)");
    expect(withoutName).toContain("anthropic/claude-y");
    expect(withoutName).not.toContain("(claude-y)");
  });

  test("routes agent errors for both a context and the system channel", () => {
    log.logAgentError(ctx, "ctx failure");
    log.logAgentError("system", "system failure");
    const out = cap.output();
    expect(out).toContain("[#general:bob]");
    expect(out).toContain("[system]");
    expect(out).toContain("ctx failure");
    expect(out).toContain("system failure");
  });
});

describe("log usage summary", () => {
  let cap: ReturnType<typeof captureConsole>;
  const ctx: LogContext = { conversationId: "C1", conversationName: "general", userName: "bob" };
  const usage = {
    input: 1200,
    output: 3400,
    cacheRead: 800,
    cacheWrite: 0,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.005, cacheWrite: 0, total: 0.035 },
  };

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.spy.mockRestore();
  });

  test("returns a markdown summary and computes the cache-hit percentage", () => {
    const summary = log.logUsageSummary(ctx, usage);
    expect(summary).toContain("_Usage Summary_");
    expect(summary).toContain("Input: 1,200 tokens");
    expect(summary).toContain("Output: 3,400 tokens");
    // 800 / (1200 + 800 + 0) = 40.0%
    expect(summary).toContain("CH 40.0%");
    expect(summary).toContain("= *$0.0350*");
    expect(summary).not.toContain("Context:");
  });

  test("reports 0.0% cache hit when there is no cacheable input", () => {
    const summary = log.logUsageSummary(ctx, {
      ...usage,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(summary).toContain("CH 0.0%");
  });

  test("includes a context line with human-friendly token counts when provided", () => {
    const summary = log.logUsageSummary(ctx, usage, 5_000, 200_000);
    // formatTokenCount: 5000 (<10k) -> "5.0k", 200000 -> "200k"
    expect(summary).toContain("Context: 5.0k / 200k (2.5%)");
  });

  test("formats sub-thousand context counts without a suffix", () => {
    const summary = log.logUsageSummary(ctx, usage, 500, 1_000_000);
    // 500 -> "500", 1_000_000 -> "1.0M"
    expect(summary).toContain("Context: 500 / 1.0M");
  });
});

describe("log system + startup messages", () => {
  let cap: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    cap = captureConsole();
  });

  afterEach(() => {
    cap.spy.mockRestore();
  });

  test("logInfo and logWarning emit system-tagged lines", () => {
    log.logInfo("booted");
    log.logWarning("careful", "extra detail");
    const out = cap.output();
    expect(out).toContain("[system] booted");
    expect(out).toContain("⚠ careful");
    expect(out).toContain("extra detail");
  });

  test("logWarning omits the detail block when no details are given", () => {
    log.logWarning("just a warning");
    expect(cap.lines.length).toBe(1);
  });

  test("startup, connect, disconnect and backfill lines render", () => {
    log.logStartup("/work", "host");
    log.logConnected("slack");
    log.logDisconnected();
    log.logBackfillStart(3);
    log.logBackfillChannel("general", 42);
    log.logBackfillComplete(100, 2500);
    const out = cap.output();
    expect(out).toContain("Working directory: /work");
    expect(out).toContain("Sandbox: host");
    expect(out).toContain("connected to slack");
    expect(out).toContain("Mikan disconnected.");
    expect(out).toContain("Backfilling 3 channels");
    expect(out).toContain("#general: 42 messages");
    expect(out).toContain("Backfill complete: 100 messages in 2.5s");
  });
});
