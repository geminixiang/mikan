import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConversationResponder } from "../types.js";
import {
  activateRunPresentation,
  attachSessionEventHandlers,
  createRunState,
} from "../harness/presenter.js";
import type { MikanAgentSession } from "../harness/session.js";
import type { PlatformToolRoles, HarnessEvent, HarnessEventListener } from "../harness/types.js";
import { startOperationSpan } from "../observability/index.js";

vi.mock("../observability/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../observability/index.js")>();
  return { ...original, startOperationSpan: vi.fn(original.startOperationSpan) };
});

const NO_PLATFORM_TOOLS: PlatformToolRoles = {
  platformTools: new Set(),
  finalResponseTools: new Set(),
};

function makeResponder(): ConversationResponder & {
  appendResponseDelta: ReturnType<typeof vi.fn>;
  finishResponse: ReturnType<typeof vi.fn>;
  replaceResponse: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  respondDiagnostic: ReturnType<typeof vi.fn>;
} {
  return {
    appendResponseDelta: vi.fn().mockResolvedValue(undefined),
    finishResponse: vi.fn().mockResolvedValue(undefined),
    replaceResponse: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
    respondDiagnostic: vi.fn().mockResolvedValue(undefined),
    respondToolResult: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    setWorking: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function resettableRunState(state = createRunState()) {
  const {
    responder: _responder,
    logCtx: _logCtx,
    queue: _queue,
    triggerAttribution: _triggerAttribution,
    ...resettable
  } = state;
  return resettable;
}

function attachPresenter(platformToolRoles = NO_PLATFORM_TOOLS) {
  let listener: HarnessEventListener | undefined;
  const session = {
    subscribe(next: HarnessEventListener) {
      listener = next;
      return () => undefined;
    },
  } as MikanAgentSession;
  const responder = makeResponder();
  const runState = createRunState();
  const runQueue = activateRunPresentation(runState, {
    responder,
    sessionConversation: "C1",
    userName: "alice",
    sessionUuid: "session-1",
    triggerAttribution: "@alice",
  });
  const model = fauxProvider().getModel();

  attachSessionEventHandlers({
    session,
    runState,
    model,
    agentConfig: { provider: "faux", model: model.id, thinkingLevel: "off" },
    platformToolRoles,
  });

  async function emit(event: HarnessEvent): Promise<void> {
    if (!listener) throw new Error("presenter listener was not attached");
    await listener(event);
  }

  return { emit, responder, runQueue, runState };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("presenter event routing", () => {
  test("disposal cancels scheduled progress and ignores events until reactivation", async () => {
    vi.useFakeTimers();
    const { emit, responder, runQueue, runState } = attachPresenter();
    await emit({
      type: "tool_execution_update",
      toolCallId: "subagent-1",
      toolName: "subagent",
      args: {},
      partialResult: {
        details: {
          progress: {
            mode: "single",
            nodes: [{ id: "node-1", label: "Inspect code", status: "running" }],
          },
        },
      },
    });
    expect(vi.getTimerCount()).toBe(1);
    runQueue.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await emit({ type: "message_end", message: fauxAssistantMessage("ignored") });
    await vi.runAllTimersAsync();
    await runQueue.wait();
    expect(responder.replaceResponse).not.toHaveBeenCalled();
    expect(responder.finishResponse).not.toHaveBeenCalled();

    const nextResponder = makeResponder();
    const next = activateRunPresentation(runState, {
      responder: nextResponder,
      sessionConversation: "C1",
      userName: "bob",
      sessionUuid: "session-1",
      triggerAttribution: undefined,
    });
    try {
      await emit({ type: "message_end", message: fauxAssistantMessage("next run") });
      await next.wait();
      expect(nextResponder.finishResponse).toHaveBeenCalledWith("next run");
      expect(responder.finishResponse).not.toHaveBeenCalled();
      expect(nextResponder.replaceResponse).not.toHaveBeenCalled();
    } finally {
      next.dispose();
    }
  });

  test("wait includes delayed output and disposal does not cancel already queued output", async () => {
    const { emit, responder, runQueue } = attachPresenter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    responder.finishResponse.mockImplementation(() => gate);
    await emit({ type: "message_end", message: fauxAssistantMessage("queued answer") });
    let settled = false;
    const waiting = runQueue.wait().then(() => {
      settled = true;
    });
    try {
      runQueue.dispose();
      await Promise.resolve();
      expect(responder.finishResponse).toHaveBeenCalledWith(
        "queued answer\n\n_Triggered by @alice_",
      );
      expect(settled).toBe(false);
    } finally {
      release();
      await waiting;
    }
    expect(settled).toBe(true);
  });

  test("routes the assistant start, delta, and end sequence", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter();
    const partial = fauxAssistantMessage("Hel");
    const complete = fauxAssistantMessage("Hello");

    await emit({ type: "message_start", message: partial });
    await emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hel",
        partial,
      },
    });
    await emit({ type: "message_end", message: complete });
    await runQueue.wait();

    expect(runState.llmCallCount).toBe(1);
    expect(runState.assistantMessageCount).toBe(1);
    expect(runState.outputCharacters).toBe(5);
    expect(runState.responseModel).toBe(complete.model);
    expect(runState.firstTokenLatencyMs).toBeTypeOf("number");
    expect(runState.stopReason).toBe("stop");
    expect(runState.totalUsage).toEqual({
      input: complete.usage.input,
      output: complete.usage.output,
      cacheRead: complete.usage.cacheRead,
      cacheWrite: complete.usage.cacheWrite,
      cost: complete.usage.cost,
    });
    expect(responder.appendResponseDelta).toHaveBeenCalledWith("Hel");
    expect(responder.finishResponse).toHaveBeenCalledWith("Hello\n\n_Triggered by @alice_");
  });

  test("routes tool start and end while keeping pending state in sync", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter();

    await emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { label: "Inspect file" },
    });
    expect(runState.pendingTools.has("tool-1")).toBe(true);

    await emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: "contents",
      isError: false,
    });
    await runQueue.wait();

    expect(runState.pendingTools.has("tool-1")).toBe(false);
    expect(runState.toolCallCount).toBe(1);
    expect(runState.toolErrorCount).toBe(0);
    expect(runState.toolInputCharacters).toBeGreaterThan(0);
    expect(runState.toolOutputCharacters).toBe("contents".length);
    expect(runState.toolProgress.get("tool-1")).toEqual({
      label: "Inspect file",
      status: "done",
    });
    expect(responder.replaceResponse.mock.calls.map(([text]) => text)).toEqual([
      "• Inspect file",
      "✓ Inspect file",
    ]);
  });

  test("a successful call to a declared final-response tool suppresses the assistant's final text", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter({
      platformTools: new Set(["post_card"]),
      finalResponseTools: new Set(["post_card"]),
    });

    await emit({
      type: "tool_execution_start",
      toolCallId: "card-1",
      toolName: "post_card",
      args: { label: "Post card" },
    });
    await emit({
      type: "tool_execution_end",
      toolCallId: "card-1",
      toolName: "post_card",
      result: "posted",
      isError: false,
    });
    await emit({ type: "message_end", message: fauxAssistantMessage("do not post this") });
    await runQueue.wait();

    expect(runState.finalResponseHandledByTool).toBe(true);
    expect(responder.finishResponse).not.toHaveBeenCalled();
  });

  test("a failed or undeclared tool call does not claim the final response", async () => {
    const { emit, runState } = attachPresenter({
      platformTools: new Set(["post_card"]),
      finalResponseTools: new Set(["post_card"]),
    });

    await emit({
      type: "tool_execution_end",
      toolCallId: "card-1",
      toolName: "post_card",
      result: "failed",
      isError: true,
    });
    await emit({
      type: "tool_execution_end",
      toolCallId: "other-1",
      toolName: "slack_blockkit",
      result: "posted",
      isError: false,
    });

    expect(runState.finalResponseHandledByTool).toBe(false);
  });

  test("categorizes declared platform tools as platform tools", async () => {
    const { emit } = attachPresenter({
      platformTools: new Set(["post_card"]),
      finalResponseTools: new Set(),
    });
    const startSpan = vi.mocked(startOperationSpan);
    startSpan.mockClear();

    await emit({
      type: "tool_execution_start",
      toolCallId: "card-1",
      toolName: "post_card",
      args: { label: "Post card" },
    });
    await emit({
      type: "tool_execution_start",
      toolCallId: "blockkit-1",
      toolName: "slack_blockkit",
      args: { label: "Post blocks" },
    });

    expect(startSpan.mock.calls.map(([, attrs]) => attrs?.["mikan.tool.category"])).toEqual([
      "platform",
      "function",
    ]);
  });

  test("prefixes jev and jev_browser progress labels so users can tell which steps came from them", async () => {
    const { emit, runState } = attachPresenter();

    await emit({
      type: "tool_execution_start",
      toolCallId: "tool-jev",
      toolName: "jev",
      args: { label: "Classify urgency" },
    });
    expect(runState.toolProgress.get("tool-jev")).toEqual({
      label: "jev · Classify urgency",
      status: "running",
    });

    await emit({
      type: "tool_execution_start",
      toolCallId: "tool-jev-browser",
      toolName: "jev_browser",
      args: { label: "Detect the video player" },
    });
    expect(runState.toolProgress.get("tool-jev-browser")).toEqual({
      label: "jev_browser · Detect the video player",
      status: "running",
    });
  });

  test("does not double the tool name when jev_browser is called without a label", async () => {
    const { emit, runState } = attachPresenter();

    await emit({
      type: "tool_execution_start",
      toolCallId: "tool-jev-browser-nolabel",
      toolName: "jev_browser",
      args: {},
    });
    expect(runState.toolProgress.get("tool-jev-browser-nolabel")).toEqual({
      label: "jev_browser",
      status: "running",
    });
  });

  test("retains completed progress in start order while parallel tools settle out of order", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter();
    try {
      for (const id of ["first", "second"]) {
        await emit({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "read",
          args: { label: id },
        });
      }
      await runQueue.wait();
      expect([...runState.pendingTools.keys()]).toEqual(["first", "second"]);

      await emit({
        type: "tool_execution_end",
        toolCallId: "second",
        toolName: "read",
        result: "failed",
        isError: true,
      });
      await runQueue.wait();
      expect([...runState.pendingTools.keys()]).toEqual(["first"]);
      expect(responder.replaceResponse).toHaveBeenLastCalledWith("• first\n✗ second");

      await emit({
        type: "tool_execution_end",
        toolCallId: "first",
        toolName: "read",
        result: "contents",
        isError: false,
      });
      await runQueue.wait();
      expect(runState.pendingTools.size).toBe(0);
      expect([...runState.toolProgress.keys()]).toEqual(["first", "second"]);
      expect(responder.replaceResponse).toHaveBeenLastCalledWith("✓ first\n✗ second");

      await emit({ type: "message_end", message: fauxAssistantMessage("answer") });
      await runQueue.wait();
      expect(responder.finishResponse).toHaveBeenLastCalledWith(
        "✓ first\n✗ second\n\nanswer\n\n_Triggered by @alice_",
      );
    } finally {
      runQueue.dispose();
    }
  });

  test("routes subagent updates and suppresses assistant deltas while progress is live", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter();
    const partial = fauxAssistantMessage("hidden");

    await emit({
      type: "tool_execution_start",
      toolCallId: "subagent-1",
      toolName: "subagent",
      args: { label: "Delegate work" },
    });
    await emit({
      type: "tool_execution_update",
      toolCallId: "subagent-1",
      toolName: "subagent",
      args: { label: "Delegate work" },
      partialResult: {
        details: {
          progress: {
            mode: "single",
            nodes: [{ id: "node-1", label: "Inspect code", status: "running" }],
          },
        },
      },
    });
    await vi.waitFor(() => expect(responder.replaceResponse).toHaveBeenCalled());
    await runQueue.wait();

    expect(runState.subagentProgress.get("subagent-1")).toEqual({
      mode: "single",
      nodes: [{ id: "node-1", label: "Inspect code", status: "running" }],
    });
    expect(runState.subagentToolCalls.has("subagent-1")).toBe(true);
    expect(runState.suppressResponseDeltas).toBe(true);
    expect(responder.replaceResponse).toHaveBeenCalledWith(
      expect.stringContaining("Inspect code"),
      undefined,
    );

    await emit({
      type: "message_update",
      message: partial,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hidden",
        partial,
      },
    });
    expect(responder.appendResponseDelta).not.toHaveBeenCalled();
  });

  test("routes compaction, retry, and budget lifecycle diagnostics", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter();

    await emit({ type: "compaction_start", reason: "threshold" });
    await emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "temporary failure",
    });
    await emit({
      type: "budget_exceeded",
      reason: "call limit",
      tokens: 100,
      costUsd: 0.1,
      llmCalls: 2,
      durationMs: 500,
    });
    await runQueue.wait();

    expect(responder.respond.mock.calls.map(([text]) => text)).toEqual([
      "_Compacting context..._",
      "_Retrying (1/3)..._",
    ]);
    expect(responder.respondDiagnostic).toHaveBeenCalledWith(
      "_Stopped: run budget exceeded (call limit)_",
      { style: "error" },
    );
    expect(runState.compactionCount).toBe(1);
    expect(runState.retryCount).toBe(1);
    expect(runState.budgetExceeded).toBe(true);
  });

  test("reactivation clears completed tool progress, subagent dashboard, and attribution", async () => {
    const { emit, responder, runQueue, runState } = attachPresenter();
    try {
      await emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { label: "Inspect file" },
      });
      await emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: "contents",
        isError: false,
      });
      await emit({ type: "message_end", message: fauxAssistantMessage("first answer") });
      await runQueue.wait();
      expect(responder.finishResponse).toHaveBeenLastCalledWith(
        "✓ Inspect file\n\nfirst answer\n\n_Triggered by @alice_",
      );

      await emit({
        type: "tool_execution_start",
        toolCallId: "subagent-1",
        toolName: "subagent",
        args: { label: "Delegate work" },
      });
      await emit({
        type: "tool_execution_update",
        toolCallId: "subagent-1",
        toolName: "subagent",
        args: { label: "Delegate work" },
        partialResult: {
          details: {
            progress: {
              mode: "single",
              nodes: [{ id: "node-1", label: "Inspect code", status: "running" }],
            },
          },
        },
      });
      await emit({
        type: "tool_execution_end",
        toolCallId: "subagent-1",
        toolName: "subagent",
        result: "done",
        isError: false,
      });
      await runQueue.wait();
      expect(responder.replaceResponse).toHaveBeenLastCalledWith(
        expect.stringContaining("Inspect code"),
        undefined,
      );
      expect(runState.toolProgress.size).toBe(2);
      expect(runState.completedSubagentProgress).toHaveLength(1);
    } finally {
      runQueue.dispose();
    }

    const nextResponder = makeResponder();
    const next = activateRunPresentation(runState, {
      responder: nextResponder,
      sessionConversation: "C1",
      userName: "bob",
      sessionUuid: "session-1",
      triggerAttribution: undefined,
    });
    try {
      expect(resettableRunState(runState)).toEqual(resettableRunState());
      expect(runState.triggerAttribution).toBeUndefined();
      await emit({ type: "message_end", message: fauxAssistantMessage("second answer") });
      await next.wait();
      expect(nextResponder.finishResponse).toHaveBeenCalledTimes(1);
      expect(nextResponder.finishResponse).toHaveBeenCalledWith("second answer");
      expect(nextResponder.replaceResponse).not.toHaveBeenCalled();
      expect(responder.finishResponse).toHaveBeenCalledTimes(1);
    } finally {
      next.dispose();
    }
  });
});
