import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  MikanAgentSession,
  MikanModels,
  SessionStore,
  type HarnessEvent,
} from "../harness/index.js";

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

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo the input",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (_toolCallId: string, args: unknown) => ({
    content: [{ type: "text", text: `echo: ${(args as { text?: string }).text ?? ""}` }],
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
} as unknown as AgentTool;

describe("MikanAgentSession", () => {
  test("runs a prompt, persists messages, and reports the final text", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("hello from faux")]);

    const sessionFile = join(dir, "session.jsonl");
    const sessionStore = await SessionStore.create(sessionFile, dir);
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

    const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(JSON.stringify(lastAssistant)).toContain("hello from faux");

    // User + assistant messages are persisted to the session file.
    const persisted = readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } });
    const roles = persisted
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message?.role);
    expect(roles).toEqual(["user", "assistant"]);

    expect(events).toContain("message_start");
    expect(events).toContain("message_end");
    expect(events).toContain("agent_end");
  });

  test("executes tool calls and persists tool results", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const sessionStore = await SessionStore.create(join(dir, "session.jsonl"), dir);
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
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore: await SessionStore.create(join(dir, "usage.jsonl"), dir),
    });
    session.agent.sessionId = "usage-breakdown";

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
    // Would take two LLM calls (tool call, then final); the cap stops it at one.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const sessionStore = await SessionStore.create(join(dir, "session.jsonl"), dir);
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

    // The cap trips after the first LLM call and aborts the run, so the second
    // turn produces no output — the "done" response never materializes.
    expect(JSON.stringify(await sessionStore.getEntries())).not.toContain("done");
  });

  test("foldExternalUsage folds delegated spend and enforces the budget at the fold", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", {})),
      fauxAssistantMessage("done"),
    ]);

    let session: MikanAgentSession;
    const delegateTool: AgentTool = {
      name: "delegate",
      description: "Simulate a subagent run folding its spend into the parent",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        expect(session.isActiveRun).toBe(true);
        await session.foldExternalUsage({
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
        return { content: [{ type: "text", text: "delegated" }] };
      },
    } as unknown as AgentTool;
    session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [delegateTool],
      models,
      sessionStore: await SessionStore.create(join(dir, "session.jsonl"), dir),
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
    // Enforcement happens at the fold itself: the run aborts before paying
    // for another parent LLM call, so the second response never materializes.
    expect(JSON.stringify(session.messages)).not.toContain("done");
  });

  test("a captured external usage sink cannot contaminate a later prompt", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("capture", {})),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage(fauxToolCall("hold", {})),
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
      parameters: { type: "object", properties: {} },
      execute: async () => {
        firstRunSink = session.captureExternalUsageSink();
        return { content: [{ type: "text", text: "captured" }] };
      },
    } as unknown as AgentTool;
    const holdTool: AgentTool = {
      name: "hold",
      description: "Keep the second prompt active",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        secondRunStarted!();
        await secondRunGate;
        return { content: [{ type: "text", text: "released" }] };
      },
    } as unknown as AgentTool;
    session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [captureTool, holdTool],
      models,
      sessionStore: await SessionStore.create(join(dir, "usage-owner.jsonl"), dir),
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

  test("counts compaction completion usage in run stats", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("compacted history")]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 15 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "compaction-usage.jsonl"), dir),
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact");

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThan(11);
    expect(faux.state.callCount).toBe(2);
  });

  test("compaction usage can trip the token budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("compacted history")]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 15 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "compaction-budget.jsonl"), dir),
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxTokens: 20 } });

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThanOrEqual(20);
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
  });

  test("overflow recovery does not retry after compaction exceeds the token budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "context length exceeded",
      }),
      fauxAssistantMessage("compacted history"),
      fauxAssistantMessage("retry must not run"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 100 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "overflow-budget.jsonl"), dir),
      settings: { compaction: { reserveTokens: 50, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxTokens: 20 } });

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThanOrEqual(20);
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify(session.messages)).not.toContain("retry must not run");
  });

  test("a compaction completion does not start at the LLM-call cap", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("initial"),
      fauxAssistantMessage("compaction must not run"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 15 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "compaction-call-cap.jsonl"), dir),
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
      sessionStore: await SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    await session.prompt("answer directly", { budget: { maxLlmCalls: 1 } });

    expect(session.getLastRunStats()).toMatchObject({ llmCalls: 1 });
    expect(session.getLastRunStats().budgetExceededReason).toBeUndefined();
    expect(JSON.stringify(session.messages)).toContain("done in one");
  });

  test("throws a clear error when provider auth is missing", async () => {
    // Custom provider with no key configured anywhere: auth resolution fails.
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
      sessionStore: await SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    await expect(session.prompt("hi")).rejects.toThrow(/No credentials for provider/);
  });
});
