import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import type { HarnessEvent } from "../harness/types.js";
import { compactionSummaryOf } from "../sessions/compaction-summary.js";
import { SessionStore } from "../sessions/session-store.js";
import { contextMessages } from "./session-context.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-runner-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function createFauxSetup(): {
  models: MikanModels;
  faux: ReturnType<typeof fauxProvider>;
  model: Model<Api>;
} {
  const models = MikanModels.create({
    modelsJsonPath: join(dir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux, model: faux.getModel() as Model<Api> };
}

const echoParameters = Type.Object({ text: Type.Optional(Type.String()) });

const echoTool: AgentTool<typeof echoParameters> = {
  name: "echo",
  label: "echo",
  description: "Echo the input",
  parameters: echoParameters,
  execute: async (_toolCallId, args) => ({
    content: [{ type: "text", text: `echo: ${args.text ?? ""}` }],
    details: { source: "echo" },
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }),
};

async function seedCompactableHistory(sessionStore: SessionStore): Promise<void> {
  await sessionStore.appendMessage({
    role: "user",
    content: [{ type: "text", text: "old history" }],
    timestamp: Date.now(),
  });
  const previous = fauxAssistantMessage("previous answer");
  previous.usage.input = 20;
  previous.usage.totalTokens = 20;
  await sessionStore.appendMessage(previous);
}

describe("MikanAgentSession", () => {
  test("a run Pi settles with a model error reports a failed status", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 bad request" }),
    ]);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.inMemory(),
      settings: { retry: { enabled: false } },
    });

    await session.prompt("hi");

    expect(session.getLastRunStats().status).toBe("failed");
    expect(
      session.lastRunMessages.findLast((message) => message.role === "assistant"),
    ).toMatchObject({
      stopReason: "error",
    });
  });

  test("runs a prompt, persists messages, and reports the final text", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("hello from faux")]);

    const sessionFile = join(dir, "session.jsonl");
    const sessionStore = await SessionStore.create(sessionFile);
    const session = new MikanAgentSession({
      systemPrompt: "You are a test bot.",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
    });

    const events: string[] = [];
    session.subscribe((event: HarnessEvent) => {
      events.push(event.type);
    });

    await session.prompt("hi");

    const lastAssistant = (await contextMessages(session)).findLast(
      (message) => message.role === "assistant",
    );
    expect(lastAssistant).toBeDefined();
    expect(JSON.stringify(lastAssistant)).toContain("hello from faux");

    const persisted = await (await SessionStore.inspect(sessionFile)).getEntries();
    const roles = persisted
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message.role);
    expect(roles).toEqual(["user", "assistant"]);

    expect(events).toContain("message_start");
    expect(events).toContain("message_end");
  });

  test("executes tool calls and persists tool results", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const sessionStore = await SessionStore.create(join(dir, "session.jsonl"));
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
    });

    await session.prompt("run the tool");

    const roles = (await sessionStore.getEntries())
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message: { role: string } }).message.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  test("preserves the complete usage breakdown across assistant turns", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore: await SessionStore.create(join(dir, "usage.jsonl")),
    });

    await session.prompt("run the tool");

    const stats = session.getLastRunStats();
    expect(stats.usage.cacheRead).toBeGreaterThan(0);
    expect(stats.usage.cacheWrite).toBeGreaterThan(0);
    expect(stats.usage.totalTokens).toBe(
      stats.usage.input + stats.usage.output + stats.usage.cacheRead + stats.usage.cacheWrite,
    );
    expect(stats.tokens).toBe(stats.usage.totalTokens);
    expect(stats.costUsd).toBe(stats.usage.cost.total);
  });

  test("budget circuit breaker aborts a run that exceeds the LLM-call cap", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const sessionStore = await SessionStore.create(join(dir, "session.jsonl"));
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
    });

    const events: HarnessEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt("run the tool", { budget: { maxLlmCalls: 1 } });

    const budgetEvent = events.find((event) => event.type === "budget_exceeded");
    expect(budgetEvent).toBeDefined();
    if (budgetEvent?.type === "budget_exceeded") {
      expect(budgetEvent.llmCalls).toBe(1);
      expect(budgetEvent.reason).toContain("LLM calls");
    }

    expect(JSON.stringify(await sessionStore.getEntries())).not.toContain("done");
  });

  test("external usage sink folds delegated spend and enforces the budget at the fold", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    let session: MikanAgentSession;
    const delegateTool: AgentTool = {
      name: "delegate",
      description: "Simulate a subagent run folding its spend into the parent",
      label: "test",
      parameters: Type.Object({}),
      execute: async () => {
        expect(session.isActiveRun).toBe(true);
        await session.captureExternalUsageSink()({
          input: 1000,
          output: 500,
          cacheRead: 3000,
          cacheWrite: 500,
          cacheWrite1h: 200,
          reasoning: 100,
          totalTokens: 5000,
          cost: {
            input: 0.25,
            output: 0.5,
            cacheRead: 0.25,
            cacheWrite: 0.25,
            total: 1.25,
          },
        });
        return { content: [{ type: "text", text: "delegated" }], details: undefined };
      },
    };
    session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [delegateTool],
      models,
      sessionStore: await SessionStore.create(join(dir, "session.jsonl")),
    });

    const events: HarnessEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt("delegate work", { budget: { maxCostUsd: 1 } });

    expect(session.isActiveRun).toBe(false);
    const stats = session.getLastRunStats();
    expect(stats.tokens).toBeGreaterThanOrEqual(5000);
    expect(stats.costUsd).toBeGreaterThanOrEqual(1.25);
    expect(stats.usage).toMatchObject({
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
      cacheWrite1h: 200,
      reasoning: 100,
    });
    expect(stats.usage.cacheRead).toBeGreaterThanOrEqual(3000);
    expect(stats.usage.cacheWrite).toBeGreaterThanOrEqual(500);
    expect(stats.budgetExceededReason).toContain("cost");
    expect(events.some((event) => event.type === "budget_exceeded")).toBe(true);
    expect(JSON.stringify(await contextMessages(session))).not.toContain("done");
  });

  test("a captured external usage sink cannot contaminate a later prompt", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("capture", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("second done"),
    ]);

    let session: MikanAgentSession;
    let firstRunSink: ReturnType<MikanAgentSession["captureExternalUsageSink"]> | undefined;
    let releaseSecondRun: (() => void) | undefined;
    let secondRunStarted: (() => void) | undefined;
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve;
    });
    const secondRunReady = new Promise<void>((resolve) => {
      secondRunStarted = resolve;
    });
    const captureTool: AgentTool = {
      name: "capture",
      description: "Capture this prompt's external usage sink",
      label: "test",
      parameters: Type.Object({}),
      execute: async () => {
        firstRunSink = session.captureExternalUsageSink();
        return { content: [{ type: "text", text: "captured" }], details: undefined };
      },
    };
    const holdTool: AgentTool = {
      name: "hold",
      description: "Keep the second prompt active",
      label: "test",
      parameters: Type.Object({}),
      execute: async () => {
        secondRunStarted!();
        await secondRunGate;
        return { content: [{ type: "text", text: "released" }], details: undefined };
      },
    };
    session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [captureTool, holdTool],
      models,
      sessionStore: await SessionStore.create(join(dir, "usage-owner.jsonl")),
    });

    await session.prompt("capture usage ownership");
    expect(firstRunSink).toBeDefined();

    const secondPrompt = session.prompt("start another run");
    await secondRunReady;
    const secondRunTokens = session.getLastRunStats().tokens;
    await firstRunSink!({
      input: 5000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5000,
      cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    });

    expect(session.getLastRunStats().tokens).toBe(secondRunTokens);
    releaseSecondRun!();
    await secondPrompt;
  });

  test("counts compaction usage in run stats", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("compacted history"), fauxAssistantMessage("answer")]);

    const sessionStore = await SessionStore.create(join(dir, "compaction-usage.jsonl"));
    await seedCompactableHistory(sessionStore);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: Object.assign(model, { contextWindow: 15 }),
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact");

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThan(11);
    expect((await contextMessages(session)).map(compactionSummaryOf)).toContain(
      "compacted history",
    );
    expect(faux.state.callCount).toBe(2);
  });

  test("compaction usage can trip the token budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("compacted history"),
      fauxAssistantMessage("must not answer"),
    ]);

    const sessionStore = await SessionStore.create(join(dir, "compaction-budget.jsonl"));
    await seedCompactableHistory(sessionStore);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: Object.assign(model, { contextWindow: 15 }),
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxTokens: 1 } });

    expect(session.getLastRunStats().llmCalls).toBe(1);
    expect(JSON.stringify(await contextMessages(session))).not.toContain("must not answer");
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
  });

  test("overflow recovery does not retry after compaction exceeds the token budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "prompt is too long: 120000 tokens > 100000 maximum",
      }),
      fauxAssistantMessage("compacted history"),
      fauxAssistantMessage("retry must not run"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: Object.assign(model, { contextWindow: 100 }),
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await (async () => {
        const store = await SessionStore.create(join(dir, "overflow-budget.jsonl"));
        await seedCompactableHistory(store);
        return store;
      })(),
      settings: { compaction: { reserveTokens: 50, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxTokens: 20 } });

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThanOrEqual(20);
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify(await contextMessages(session))).not.toContain("retry must not run");
  });

  test("a model turn does not start once compaction reached the LLM-call cap", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("compacted history"),
      fauxAssistantMessage("answer must not run"),
    ]);

    const sessionStore = await SessionStore.create(join(dir, "compaction-call-cap.jsonl"));
    await seedCompactableHistory(sessionStore);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: Object.assign(model, { contextWindow: 15 }),
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxLlmCalls: 1 } });

    expect(session.getLastRunStats()).toMatchObject({ llmCalls: 1 });
    expect(session.getLastRunStats().budgetExceededReason).toContain("LLM calls");
    expect(faux.state.callCount).toBe(1);
  });

  test("a final response at the LLM-call cap completes without tripping the budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("done in one")]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "session.jsonl")),
    });

    await session.prompt("answer directly", { budget: { maxLlmCalls: 1 } });

    expect(session.getLastRunStats()).toMatchObject({ llmCalls: 1 });
    expect(session.getLastRunStats().budgetExceededReason).toBeUndefined();
    expect(JSON.stringify(await contextMessages(session))).toContain("done in one");
  });

  test("throws a clear error when provider auth is missing", async () => {
    const modelsJsonPath = join(dir, "models.json");
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "keyless-provider": {
            api: "openai-completions",
            baseUrl: "http://localhost:1/v1",
            models: [{ id: "m1", name: "M1", input: ["text"], reasoning: false }],
          },
        },
      }),
    );
    const models = MikanModels.create({ modelsJsonPath });
    const model = models.find("keyless-provider", "m1");
    expect(model).toBeDefined();

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: model!,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "session.jsonl")),
    });

    await expect(session.prompt("hi")).rejects.toThrow(/No credentials for provider/);
  });
});
