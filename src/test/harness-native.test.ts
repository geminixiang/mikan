import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import { TODO_CONTEXT, getOrThrow, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MikanAgentSession, MikanModels, type HarnessEvent } from "../harness/index.js";
import { SessionStore } from "../sessions/session-store.js";
import type { MikanAgentSessionOptions } from "../harness/types.js";

test("plain AgentTool integrations do not require an execution context", () => {
  expectTypeOf<
    Omit<MikanAgentSessionOptions, "toolContext">
  >().toExtend<MikanAgentSessionOptions>();
});

let dir: string;
const stores: SessionStore[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-native-harness-"));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const file = join(dir, "session.jsonl");
  const wrap = (store: SessionStore, tools: AgentTool[] = []) => {
    stores.push(store);
    return new MikanAgentSession({
      model,
      models,
      sessionStore: store,
      tools,
      thinkingLevel: "off",
      systemPrompt: "first prompt",
      settings: { compaction: { enabled: false } },
    });
  };
  return { models, model, faux, file, wrap };
}

test("native lane includes host history writes and survives close/reopen without duplicates", async () => {
  const { faux, file, wrap } = setup();
  const store = await SessionStore.create(file, dir);
  const session = wrap(store);
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("external history");
      return fauxAssistantMessage("second answer");
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("first answer");
      expect(JSON.stringify(context.messages)).toContain("second answer");
      return fauxAssistantMessage("third answer");
    },
  ]);
  const events: HarnessEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  await session.prompt("first");
  const eventCount = events.length;
  await store.appendMessage({ role: "user", content: "external history", timestamp: Date.now() });
  expect(events).toHaveLength(eventCount);
  await session.prompt("second");
  await store.close();
  const reopened = await SessionStore.open(file);
  await wrap(reopened).prompt("third");
  const messages = (await reopened.getEntries()).filter((entry) => entry.type === "message");
  expect(messages).toHaveLength(7);
  expect(faux.state.callCount).toBe(3);
  const inspected = await SessionStore.inspect(file);
  expect(JSON.stringify(await inspected.buildSessionContext())).toContain("third answer");
});

test("resume drives a durably accepted operation after reopening the store", async () => {
  const { models, model, faux, file, wrap } = setup();
  const store = await SessionStore.create(file, dir);
  stores.push(store);
  const harness = await store.createHarness({
    models: models.models,
    model,
    compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
  });
  const lane = await harness.lane("main", TODO_CONTEXT);
  const admission = getOrThrow(
    await lane.accept({ kind: "prompt", prompt: "recover this request" }, TODO_CONTEXT),
  );
  expect(faux.state.callCount).toBe(0);
  await store.close();
  const reopened = await SessionStore.open(file);
  const session = wrap(reopened);
  faux.setResponses([
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("recover this request");
      return fauxAssistantMessage("recovered answer");
    },
  ]);
  await session.resume();
  expect(faux.state.callCount).toBe(1);
  expect(JSON.stringify(session.messages)).toContain("recovered answer");
  // The original operation is settled, so a later prompt can be admitted.
  faux.setResponses([fauxAssistantMessage("next answer")]);
  await session.prompt("next request");
  expect(faux.state.callCount).toBe(2);
  expect(admission.operationId).toBeTruthy();
});

test("per-prompt tools and system prompt update through Pi without leaking to later turns", async () => {
  const { faux, file, wrap } = setup();
  const invoke = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "used temporary tool" }],
    details: {},
  }));
  const tool: AgentTool = {
    name: "temporary",
    label: "temporary",
    description: "Temporary grant",
    parameters: { type: "object", properties: {} },
    execute: invoke,
  };
  const session = wrap(await SessionStore.create(file, dir));
  faux.setResponses([
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("first prompt");
      expect(getCurrentTools(context.messages).map((item) => item.name)).toEqual(["temporary"]);
      return fauxAssistantMessage(fauxToolCall("temporary", {}));
    },
    fauxAssistantMessage("first done"),
    (context) => {
      expect(getCurrentSystemPrompt(context.messages)).toContain("updated prompt");
      expect(getCurrentTools(context.messages)).toHaveLength(0);
      return fauxAssistantMessage("second done");
    },
  ]);
  await session.prompt("first request", { tools: [tool] });
  session.setSystemPrompt("updated prompt");
  await session.prompt("second request");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(faux.state.callCount).toBe(3);
});

test("tool progress retains arguments and each committed message is presented once", async () => {
  const { faux, file, wrap } = setup();
  const tool: AgentTool = {
    name: "progress",
    label: "progress",
    description: "Report progress",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async (id, args, signal, onUpdate) => {
      expect(id).toEqual(expect.any(String));
      expect(args).toEqual({ text: "original args" });
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      expect(onUpdate).toEqual(expect.any(Function));
      onUpdate?.({ content: [{ type: "text", text: "working" }], details: {} });
      return { content: [{ type: "text", text: "finished" }], details: {} };
    },
  };
  const store = await SessionStore.create(file, dir);
  const session = wrap(store, [tool]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("progress", { text: "original args" })),
    fauxAssistantMessage("done"),
  ]);
  const events: HarnessEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  await session.prompt("report progress");
  expect(events).toContainEqual(
    expect.objectContaining({ type: "tool_execution_update", args: { text: "original args" } }),
  );
  expect(events.filter((event) => event.type === "message_end")).toHaveLength(4);
  expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
  expect(
    events
      .filter((event) =>
        [
          "agent_start",
          "tool_execution_start",
          "tool_execution_update",
          "tool_execution_end",
          "agent_end",
        ].includes(event.type),
      )
      .map((event) => event.type),
  ).toEqual([
    "agent_start",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_end",
  ]);
  expect(session.getLastRunStats()).toMatchObject({
    toolCalls: 1,
    toolCallCounts: { progress: 1 },
  });
  const persisted = (await store.getEntries()).filter((entry) => entry.type === "message");
  expect(persisted).toHaveLength(4);
});

test("persisted provider thinking level survives close/reopen", async () => {
  // Pi 0.85.0 fixed proxied assistant responses dropping the persisted
  // provider-native thinking level (packages/agent/CHANGELOG.md). Guard
  // that mikan's own session-store round trip preserves it too.
  const { faux, file, wrap } = setup();
  const store = await SessionStore.create(file, dir);
  const session = wrap(store);
  faux.setResponses([{ ...fauxAssistantMessage("deep answer"), providerThinkingLevel: "high" }]);
  await session.prompt("think hard");
  await store.close();

  const reopened = await SessionStore.open(file);
  stores.push(reopened);
  const persisted = (await reopened.getEntries()).filter((entry) => entry.type === "message");
  const assistantEntry = persisted.find(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  expect(assistantEntry).toBeDefined();
  expect(
    assistantEntry?.type === "message" && assistantEntry.message.role === "assistant"
      ? assistantEntry.message.providerThinkingLevel
      : undefined,
  ).toBe("high");
});

test("a successful native retry preserves reasoning and charges both requests once", async () => {
  const { faux, file, wrap } = setup();
  const session = wrap(await SessionStore.create(file, dir));
  // Avoid real backoff while exercising Pi's actual retry scheduler.
  vi.useFakeTimers();
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }),
      fauxAssistantMessage([
        { type: "thinking", thinking: "reasoning survives" },
        { type: "text", text: "recovered" },
      ]),
    ]);
    const events: HarnessEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    const run = session.prompt("recover");
    // File persistence uses real I/O; wait for the retry event before advancing time.
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "auto_retry_start")).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(faux.state.callCount).toBe(2);
    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "auto_retry_end", success: true, attempt: 1 }),
    );
    expect(JSON.stringify(session.messages)).toContain("reasoning survives");
  } finally {
    vi.useRealTimers();
  }
});
