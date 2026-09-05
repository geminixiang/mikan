import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConversationResponder } from "../adapter.js";
import {
  activateRunPresentation,
  attachSessionEventHandlers,
  createRunState,
} from "../agent/presenter.js";
import type { HarnessEvent, HarnessEventListener, MikanAgentSession } from "../harness/index.js";

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

function attachPresenter() {
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
    expect(runState.toolProgress.get("tool-1")).toEqual({
      label: "Inspect file",
      status: "done",
    });
    expect(responder.replaceResponse.mock.calls.map(([text]) => text)).toEqual([
      "• Inspect file",
      "✓ Inspect file",
    ]);
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
    const { emit, responder, runQueue } = attachPresenter();

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
      expect(runState.toolProgress.size).toBe(0);
      expect(runState.completedSubagentProgress).toEqual([]);
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
