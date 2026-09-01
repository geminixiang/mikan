import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConversationResponder } from "../adapter.js";
import { attachSessionEventHandlers, createRunQueue, createRunState } from "../agent/presenter.js";
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
  runState.responder = responder;
  runState.logCtx = {
    conversationId: "C1",
    userName: "alice",
    sessionId: "session-1",
  };
  const runQueue = createRunQueue(responder, runState);
  runState.queue = runQueue.queue;
  runState.triggerAttribution = "@alice";
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
});

describe("presenter event routing", () => {
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
});
