import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import {
  Closed,
  OperationMismatch,
  TODO_CONTEXT,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { MikanAgentSession, MikanModels, type HarnessEvent } from "../harness/index.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-cancellation-"));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(options: { tools?: AgentTool[]; compact?: boolean } = {}) {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const session = new MikanAgentSession({
    systemPrompt: "test",
    model: options.compact ? Object.assign(model, { contextWindow: 15 }) : model,
    thinkingLevel: "off",
    tools: options.tools ?? [],
    models,
    sessionStore: SessionStore.inMemory(dir),
    settings: {
      compaction: { enabled: options.compact ?? false, reserveTokens: 5, keepRecentTokens: 1 },
      retry: { baseDelayMs: 5000 },
    },
  });
  const events: HarnessEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  return { session, models, faux, events };
}

async function seedHistory(session: MikanAgentSession) {
  await session.sessionStore.appendMessage({
    role: "user",
    content: [{ type: "text", text: "old history" }],
    timestamp: Date.now(),
  });
  const previous = fauxAssistantMessage("previous answer");
  previous.usage.input = 20;
  previous.usage.totalTokens = 20;
  await session.sessionStore.appendMessage(previous);
  await session.reloadFromSession();
}

const retryError = () =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });

describe("harness run cancellation", () => {
  test.each([
    { runFails: false, cancellation: "success" },
    { runFails: true, cancellation: "success" },
    { runFails: false, cancellation: "reject" },
    { runFails: true, cancellation: "reject" },
    { runFails: false, cancellation: "closed" },
    { runFails: true, cancellation: "closed" },
    { runFails: false, cancellation: "mismatch" },
    { runFails: true, cancellation: "mismatch" },
  ])("run/cleanup failures retain their causes: %j", async ({ runFails, cancellation }) => {
    const { session, models, faux } = setup();
    const harness = await session.sessionStore.createHarness({
      models: models.models,
      model: session.model,
      compaction: { enabled: false, reserveTokens: 5, keepRecentTokens: 1 },
    });
    vi.spyOn(session.sessionStore, "createHarness").mockResolvedValueOnce(harness);
    const lane = await harness.lane("main", TODO_CONTEXT);
    const runError = new Error("drive failed");
    const cleanupError = new Closed({ message: "abort persistence failed" });
    const abort = vi.spyOn(lane, "requestAbort");
    if (cancellation === "reject") abort.mockRejectedValueOnce(cleanupError);
    if (cancellation === "closed") abort.mockResolvedValueOnce({ ok: false, error: cleanupError });
    if (cancellation === "mismatch") {
      abort.mockResolvedValueOnce({
        ok: false,
        error: new OperationMismatch({
          lane: "main",
          expectedOperationId: "already settled",
          message: "Operation already settled",
        }),
      });
    }
    const drive = lane.drive.bind(lane);
    vi.spyOn(lane, "drive").mockImplementationOnce(async (...args) => {
      const result = await drive(...args);
      if (runFails) throw runError;
      return result;
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") session.abort();
    });
    faux.setResponses([fauxAssistantMessage("answer")]);
    const run = session.prompt("cancel", { budget: { maxDurationMs: 100 } });
    const cleanupFails = cancellation === "reject" || cancellation === "closed";
    if (runFails && cleanupFails) {
      await expect(run).rejects.toBeInstanceOf(AggregateError);
      await expect(run).rejects.toMatchObject({
        cause: runError,
        errors: [runError, cleanupError],
      });
    } else if (runFails || cleanupFails) {
      await expect(run).rejects.toBe(runFails ? runError : cleanupError);
    } else {
      await expect(run).resolves.toBeUndefined();
    }
    expect(abort).toHaveBeenCalledOnce();
    expect(session.isActiveRun).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const duration = session.getLastRunStats().durationMs;
    await vi.advanceTimersByTimeAsync(200);
    expect(session.getLastRunStats().durationMs).toBe(duration);
    unsubscribe();
    faux.setResponses([fauxAssistantMessage("next answer")]);
    await expect(session.prompt("next prompt")).resolves.toBeUndefined();
    await session.sessionStore.close();
  });

  test("abort during auth prevents a model call and the next prompt can run", async () => {
    const { session, models, faux } = setup();
    faux.setResponses([fauxAssistantMessage("next prompt")]);
    const gate = deferred();
    const ready = deferred();
    const getAuth = models.getAuth.bind(models);
    vi.spyOn(models, "getAuth").mockImplementationOnce(async (model) => {
      ready.resolve();
      await gate.promise;
      return getAuth(model);
    });
    const run = session.prompt("cancel this");
    await ready.promise;
    session.abort();
    gate.resolve();
    await run;
    expect(faux.state.callCount).toBe(0);
    expect(await session.sessionStore.getEntries()).toEqual([]);
    await session.prompt("try again");
    expect(faux.state.callCount).toBe(1);
    expect(session.getLastRunStats().budgetExceededReason).toBeUndefined();
  });

  test("abort from retry-start notification prevents the retry", async () => {
    const { session, faux, events } = setup();
    faux.setResponses([retryError(), fauxAssistantMessage("must not retry")]);
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") session.abort();
    });
    const run = session.prompt("retry transient error");
    await vi.runAllTimersAsync();
    await run;
    expect(faux.state.callCount).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "auto_retry_end",
        success: false,
        finalError: "Retry cancelled",
      }),
    );
  });

  test("abort from compaction-start notification prevents summary generation", async () => {
    const { session, faux, events } = setup({ compact: true });
    faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("must not compact")]);
    session.subscribe((event) => {
      if (event.type === "compaction_start") session.abort();
    });
    await session.prompt("history to compact");
    expect(faux.state.callCount).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "compaction_end", aborted: true }),
    );
  });

  test("abort after initial compaction prevents the new model turn", async () => {
    const { session, faux } = setup({ compact: true });
    await seedHistory(session);
    faux.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("must not start")]);
    session.subscribe((event) => {
      if (event.type === "compaction_end") session.abort();
    });
    await session.prompt("new request");
    expect(faux.state.callCount).toBe(1);
    expect(JSON.stringify(session.messages)).toContain("new request");
  });

  test("initial compaction exhausting the budget prevents a new model turn", async () => {
    const { session, faux } = setup({ compact: true });
    await seedHistory(session);
    faux.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("must not start")]);
    await session.prompt("new request", { budget: { maxTokens: 1 } });
    expect(faux.state.callCount).toBe(1);
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
    expect(JSON.stringify(session.messages)).toContain("new request");
  });

  test("duration budget aborts an in-flight provider call before its response", async () => {
    const { session, faux, events } = setup();
    const ready = deferred();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    faux.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        ready.resolve();
        await gate.promise;
        return fauxAssistantMessage("late answer");
      },
    ]);
    const run = session.prompt("slow response", { budget: { maxDurationMs: 100 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(100);
    const abortedBeforeResponse = signal?.aborted;
    const notifiedBeforeResponse = events.some((event) => event.type === "budget_exceeded");
    gate.resolve();
    await run;
    expect(abortedBeforeResponse).toBe(true);
    expect(notifiedBeforeResponse).toBe(true);
    expect(events.filter((event) => event.type === "budget_exceeded")).toHaveLength(1);
    expect(faux.state.callCount).toBe(1);
  });

  test("duration budget aborts a running tool and waits for its cleanup", async () => {
    const ready = deferred();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const tool: AgentTool = {
      name: "hold",
      label: "hold",
      description: "Wait for cleanup",
      parameters: { type: "object", properties: {} },
      execute: async (_id, _args, toolSignal) => {
        signal = toolSignal;
        ready.resolve();
        await gate.promise;
        return { content: [{ type: "text", text: "cleaned up" }], details: {} };
      },
    };
    const { session, faux } = setup({ tools: [tool] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {})),
      fauxAssistantMessage("must not continue"),
    ]);
    const run = session.prompt("slow tool", { budget: { maxDurationMs: 100 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(100);
    const abortedDuringTool = signal?.aborted;
    const activeDuringCleanup = session.isActiveRun;
    gate.resolve();
    await run;
    expect(abortedDuringTool).toBe(true);
    expect(activeDuringCleanup).toBe(true);
    expect(faux.state.callCount).toBe(1);
    expect(session.isActiveRun).toBe(false);
  });

  test("duration budget cancels retry backoff without another model call", async () => {
    const { session, faux, events } = setup();
    const ready = deferred();
    faux.setResponses([retryError(), fauxAssistantMessage("must not retry")]);
    session.subscribe((event) => {
      if (event.type === "auto_retry_start") ready.resolve();
    });
    const run = session.prompt("retry", { budget: { maxDurationMs: 100 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(100);
    const notifiedAtDeadline = events.some((event) => event.type === "budget_exceeded");
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(notifiedAtDeadline).toBe(true);
    expect(faux.state.callCount).toBe(1);
  });

  test("deadline during auth prevents a later model call", async () => {
    const { session, models, faux, events } = setup();
    const ready = deferred();
    const gate = deferred();
    const getAuth = models.getAuth.bind(models);
    vi.spyOn(models, "getAuth").mockImplementationOnce(async (model) => {
      ready.resolve();
      await gate.promise;
      return getAuth(model);
    });
    const run = session.prompt("slow auth", { budget: { maxDurationMs: 100 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(100);
    const notifiedDuringAuth = events.some((event) => event.type === "budget_exceeded");
    gate.resolve();
    await run;
    expect(notifiedDuringAuth).toBe(true);
    expect(faux.state.callCount).toBe(0);
  });

  test("deadline aborts an in-flight compaction without persisting a partial summary", async () => {
    const { session, faux, events } = setup({ compact: true });
    await seedHistory(session);
    const ready = deferred();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    faux.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        ready.resolve();
        await gate.promise;
        return fauxAssistantMessage("late summary");
      },
    ]);
    const run = session.prompt("new request", { budget: { maxDurationMs: 100 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(100);
    const abortedDuringCompaction = signal?.aborted;
    gate.resolve();
    await run;
    expect(abortedDuringCompaction).toBe(true);
    expect(faux.state.callCount).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "compaction_end", aborted: true }),
    );
    expect(
      (await session.sessionStore.getEntries()).some((entry) => entry.type === "compaction"),
    ).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("new request");
  });

  test("slow budget listeners cannot delay cancellation or leak into another prompt", async () => {
    const { session, faux } = setup();
    const ready = deferred();
    const response = deferred();
    const notification = deferred();
    let signal: AbortSignal | undefined;
    faux.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        ready.resolve();
        await response.promise;
        return fauxAssistantMessage("late response");
      },
    ]);
    session.subscribe(async (event) => {
      if (event.type === "budget_exceeded") await notification.promise;
    });
    const run = session.prompt("slow response", { budget: { maxDurationMs: 100 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(100);
    const abortedBeforeNotification = signal?.aborted;
    response.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const activeBeforeNotification = session.isActiveRun;
    const overlapping = session.prompt("overlap").catch((error: unknown) => error);
    notification.resolve();
    await run;
    expect(abortedBeforeNotification).toBe(true);
    expect(activeBeforeNotification).toBe(true);
    expect(await overlapping).toBeInstanceOf(Error);
    expect(session.isActiveRun).toBe(false);
  });

  test("a deadline beyond Node's timer range does not expire after one millisecond", async () => {
    const { session, faux } = setup();
    const ready = deferred();
    const gate = deferred();
    let signal: AbortSignal | undefined;
    faux.setResponses([
      async (_context, options) => {
        signal = options?.signal;
        ready.resolve();
        await gate.promise;
        return fauxAssistantMessage("answer");
      },
    ]);
    const run = session.prompt("long budget", { budget: { maxDurationMs: 2_147_483_648 } });
    await ready.promise;
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    const abortedEarly = signal?.aborted;
    await vi.advanceTimersByTimeAsync(1);
    const abortedAtDeadline = signal?.aborted;
    gate.resolve();
    await run;
    expect(abortedEarly).toBe(false);
    expect(abortedAtDeadline).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([{ maxLlmCalls: 0 }, { maxTokens: 0 }, { maxCostUsd: 0 }, { maxDurationMs: 0 }])(
    "an already-exhausted budget starts no model call: %j",
    async (budget) => {
      const { session, faux } = setup();
      faux.setResponses([fauxAssistantMessage("must not start")]);
      await session.prompt("no budget", { budget });
      expect(faux.state.callCount).toBe(0);
      expect(session.getLastRunStats().budgetExceededReason).toBeDefined();
    },
  );

  test("completed run duration stays fixed and its deadline cannot abort a later run", async () => {
    const { session, faux } = setup();
    faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    await session.prompt("first", { budget: { maxDurationMs: 100 } });
    const duration = session.getLastRunStats().durationMs;
    await vi.advanceTimersByTimeAsync(200);
    expect(session.getLastRunStats().durationMs).toBe(duration);
    expect(vi.getTimerCount()).toBe(0);
    await session.prompt("second");
    expect(faux.state.callCount).toBe(2);
    expect(session.getLastRunStats().budgetExceededReason).toBeUndefined();
  });
});
