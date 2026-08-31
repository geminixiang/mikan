import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { Type, type TSchema } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_BUDGET,
  runSubagent,
  SUBAGENT_ABORT_GRACE_MS,
} from "../harness/subagent-runner.js";
import {
  MikanAgentSession,
  MikanModels,
  SessionStore,
  type SubagentUsage,
} from "../harness/index.js";
import { createSubagentTool } from "../tools/subagent.js";
import { SubagentSlotPool } from "../harness/subagent-slots.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-subagent-test-"));
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
  label: "echo",
  description: "Echo the input",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_toolCallId, args) => ({
    content: [{ type: "text", text: `echo: ${(args as { text: string }).text}` }],
    details: {},
  }),
};

/** A no-tool profile, so the integration tests exercise the profile path. */
const THINKER_PROFILES = new Map([
  [
    "thinker",
    {
      name: "thinker",
      description: "Reasons over supplied input only",
      systemPrompt: "Answer from the supplied task text alone.",
      tools: [],
      requiredTools: [],
    },
  ],
]);
const THINKER_MENU = new Map([["thinker", { description: "Reasons over supplied input only" }]]);

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("runSubagent", () => {
  test("uses the expanded default limits", () => {
    expect(DEFAULT_SUBAGENT_BUDGET).toEqual({
      maxTurns: 100,
      maxCostUsd: 10,
      maxDurationMs: 10 * 60 * 1000,
    });
  });

  test("uses the larger of profile and requested token allowances", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("profile"), fauxAssistantMessage("requested")]);
    const promptSpy = vi.spyOn(MikanAgentSession.prototype, "prompt");
    try {
      const profile = {
        name: "bounded",
        description: "A bounded profile",
        systemPrompt: "Stay bounded.",
        tools: [],
        requiredTools: [],
        maxTokens: 100_000,
      };
      const baseOptions = {
        defaultModel: model,
        thinkingLevel: "off" as const,
        models,
        workspaceDir: dir,
        availableTools: [],
        profiles: new Map([["bounded", profile]]),
      };

      await runSubagent({
        ...baseOptions,
        request: { task: "Use profile default", profile: "bounded" },
      });
      await runSubagent({
        ...baseOptions,
        request: { task: "Use more", profile: "bounded", budget: { maxTokens: 150_000 } },
      });

      expect(promptSpy.mock.calls[0]?.[1]?.budget?.maxTokens).toBe(100_000);
      expect(promptSpy.mock.calls[1]?.[1]?.budget?.maxTokens).toBe(150_000);
    } finally {
      promptSpy.mockRestore();
    }
  });

  test("does not let request budgets raise non-token profile caps", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("bounded")]);
    const promptSpy = vi.spyOn(MikanAgentSession.prototype, "prompt");
    try {
      const result = await runSubagent({
        request: {
          task: "Stay within the profile",
          profile: "bounded",
          budget: {
            maxTurns: 20,
            maxTokens: 20_000,
            maxCostUsd: 20,
            maxDurationMs: 20_000,
          },
        },
        defaultModel: model,
        thinkingLevel: "off",
        models,
        workspaceDir: dir,
        availableTools: [],
        profiles: new Map([
          [
            "bounded",
            {
              name: "bounded",
              description: "A bounded profile",
              systemPrompt: "Stay bounded.",
              tools: [],
              requiredTools: [],
              maxTurns: 2,
              maxTokens: 2_000,
              maxCostUsd: 2,
              maxDurationMs: 2_000,
            },
          ],
        ]),
      });

      expect(result.status).toBe("completed");
      // maxDurationMs is enforced solely by the runner's hard-deadline
      // timer; it is not forwarded into the session budget (dual authority
      // made the terminal status racy between timeout/budget_exceeded).
      expect(promptSpy.mock.calls[0]?.[1]?.budget).toEqual({
        maxLlmCalls: 2,
        maxTokens: 20_000,
        maxCostUsd: 2,
      });
    } finally {
      promptSpy.mockRestore();
    }
  });

  test("backs the normal agent's subagent tool", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { task: "Delegate this", profile: "thinker" })),
      fauxAssistantMessage("delegated result"),
      fauxAssistantMessage("parent complete"),
    ]);
    const subagentTool = createSubagentTool(
      (request) =>
        runSubagent({
          request,
          defaultModel: model,
          thinkingLevel: "off",
          models,
          workspaceDir: dir,
          availableTools: [],
          profiles: THINKER_PROFILES,
        }),
      THINKER_MENU,
    );
    const sessionStore = await SessionStore.create(join(dir, "parent.jsonl"), dir);
    const parent = new MikanAgentSession({
      systemPrompt: "Delegate focused work when useful.",
      model,
      thinkingLevel: "off",
      tools: [subagentTool],
      models,
      sessionStore,
    });

    await parent.prompt("Use a subagent");

    const persisted = JSON.stringify(await sessionStore.getEntries());
    expect(persisted).toContain("delegated result");
    expect(persisted).toContain("parent complete");
  });

  test("returns a bounded timeout while retaining the slot until active cleanup settles", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("stuck", {}))]);
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const stuckTool: AgentTool = {
      name: "stuck",
      label: "stuck",
      description: "Wait until released",
      parameters: Type.Object({}),
      execute: async () => {
        await toolGate;
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    };
    const slots = new SubagentSlotPool(1);
    const usageCalls: SubagentUsage[] = [];
    const startedAt = Date.now();
    const result = await runSubagent({
      request: { task: "Time out", tools: ["stuck"], budget: { maxDurationMs: 20 } },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [stuckTool],
      slots,
      onUsage: (usage) => {
        usageCalls.push(usage);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(20 + SUBAGENT_ABORT_GRACE_MS + 300);
    expect(result).toMatchObject({ status: "timeout", cleanupPending: true });
    expect(slots.inFlight).toBe(1);
    expect(usageCalls).toHaveLength(0);

    releaseTool!();
    await waitFor(() => slots.inFlight === 0);
    expect(usageCalls).toHaveLength(1);
  });

  test("returns a bounded cancellation while retaining the slot until active cleanup settles", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("stuck", {}))]);
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const stuckTool: AgentTool = {
      name: "stuck",
      label: "stuck",
      description: "Wait until released",
      parameters: Type.Object({}),
      execute: async () => {
        await toolGate;
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    };
    const slots = new SubagentSlotPool(1);
    const controller = new AbortController();
    const usageCalls: SubagentUsage[] = [];
    const pending = runSubagent({
      request: { task: "Cancel", tools: ["stuck"], signal: controller.signal },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [stuckTool],
      slots,
      onUsage: (usage) => {
        usageCalls.push(usage);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ status: "cancelled", cleanupPending: true });
    expect(slots.inFlight).toBe(1);
    expect(usageCalls).toHaveLength(0);

    releaseTool!();
    await waitFor(() => slots.inFlight === 0);
    expect(usageCalls).toHaveLength(1);
  });

  test("catches late prompt rejection without releasing usage or the slot twice", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage(fauxToolCall("stuck", {}))]);
    let rejectTool: ((error: Error) => void) | undefined;
    const toolGate = new Promise<void>((_, reject) => {
      rejectTool = reject;
    });
    const stuckTool: AgentTool = {
      name: "stuck",
      label: "stuck",
      description: "Reject after the caller has timed out",
      parameters: Type.Object({}),
      execute: async () => {
        await toolGate;
        return { content: [{ type: "text", text: "unreachable" }], details: {} };
      },
    };
    const slots = new SubagentSlotPool(1);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const usageCalls: SubagentUsage[] = [];
      const result = await runSubagent({
        request: { task: "Reject late", tools: ["stuck"], budget: { maxDurationMs: 20 } },
        defaultModel: model,
        thinkingLevel: "off",
        models,
        workspaceDir: dir,
        availableTools: [stuckTool],
        slots,
        onUsage: (usage) => {
          usageCalls.push(usage);
        },
      });
      expect(result).toMatchObject({ status: "timeout", cleanupPending: true });
      rejectTool!(new Error("late tool failure"));
      await waitFor(() => slots.inFlight === 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(usageCalls).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  test("returns cancelled while queued without making a model call", async () => {
    const { models, faux, model } = createFauxSetup();
    const slots = new SubagentSlotPool(1);
    const release = await slots.acquire();
    const controller = new AbortController();
    const pending = runSubagent({
      request: { task: "Never launch", signal: controller.signal },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      slots,
    });
    controller.abort();
    const result = await pending;
    release();
    expect(result.status).toBe("cancelled");
    expect(faux.state.callCount).toBe(0);
    expect(slots.inFlight).toBe(0);
  });

  test("defaults to fresh context and validates normalized recentTurns", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("fresh")]);
    const parentMessages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "parent secret" }], timestamp: 1 },
    ];
    await runSubagent({
      request: { task: "Fresh task" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      parentMessages,
    });
    expect(faux.state.callCount).toBe(1);

    const invalid = await runSubagent({
      request: { task: "Invalid", parentContext: { mode: "normalized", recentTurns: 9 } },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      parentMessages,
    });
    expect(invalid).toMatchObject({ status: "failed", error: expect.stringContaining("1 to 8") });
    expect(faux.state.callCount).toBe(1);
  });

  test("normalizes textual parent turns, reuses summary, and excludes noise", async () => {
    const { models, faux, model } = createFauxSetup();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context.messages);
        return fauxAssistantMessage("normalized");
      },
    ]);
    const parentMessages = [
      { role: "compactionSummary", summary: "existing summary", timestamp: 1 },
      { role: "user", content: [{ type: "text", text: "old turn" }], timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 3 },
      { role: "user", content: [{ type: "text", text: "recent turn" }], timestamp: 4 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "recent answer" },
          { type: "toolCall", id: "x", name: "echo", arguments: { secret: true } },
        ],
        api: "faux",
        provider: "faux",
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 5,
      },
    ] as AgentMessage[];
    const result = await runSubagent({
      request: { task: "Use context", parentContext: { mode: "normalized", recentTurns: 1 } },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      parentMessages,
    });
    expect(result.status).toBe("completed");
    expect(prompt).toContain("existing summary");
    expect(prompt).toContain("recent turn");
    expect(prompt).toContain("recent answer");
    expect(prompt).not.toContain("old turn");
    expect(prompt).not.toContain("private reasoning");
    expect(prompt).not.toContain("secret");
    expect(faux.state.callCount).toBe(1);
  });

  test("uses omitted marker without a summary and falls back to fresh without a parent", async () => {
    const { models, faux, model } = createFauxSetup();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("one");
      },
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("two");
      },
    ]);
    const common = {
      defaultModel: model,
      thinkingLevel: "off" as const,
      models,
      workspaceDir: dir,
      availableTools: [],
    };
    await runSubagent({
      ...common,
      request: { task: "With parent", parentContext: { mode: "normalized" } },
      parentMessages: [{ role: "user", content: [{ type: "text", text: "parent" }], timestamp: 1 }],
    });
    await runSubagent({
      ...common,
      request: { task: "No parent", parentContext: { mode: "normalized" } },
    });
    expect(prompts[0]).toContain("Earlier parent context omitted");
    expect(prompts[1]).not.toContain("parent_reference_context");
    expect(faux.state.callCount).toBe(2);
  });

  test("runs with fresh context and returns final text plus usage", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("subagent result")]);

    const result = await runSubagent({
      request: { task: "Do one focused task" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({
      status: "completed",
      output: "subagent result",
      text: "subagent result",
      model: { provider: "faux", id: model.id },
      turns: 1,
    });
    expect(result.runId).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toMatchObject({
      input: expect.any(Number),
      output: expect.any(Number),
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
      totalTokens: expect.any(Number),
      cost: {
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
        total: expect.any(Number),
      },
    });
    expect(result.tokens).toBe(result.usage.totalTokens);
    expect(result.costUsd).toBe(result.usage.cost.total);
  });

  test("validates structured output against a TypeBox schema", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage('{"quality":"low_content","stuck":false}')]);
    const schema = Type.Object({
      quality: Type.Union([Type.Literal("substantive"), Type.Literal("low_content")]),
      stuck: Type.Boolean(),
    });

    const result = await runSubagent({
      request: {
        task: "Classify the reply",
        outputSchema: schema,
        budget: { maxTurns: 1 },
      },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ quality: "low_content", stuck: false });
  });

  test("validates structured output against a plain JSON Schema object", async () => {
    // Tool-call arguments arrive as plain JSON: TypeBox's Kind symbol never
    // survives the wire, so outputSchema here has no [Kind] metadata.
    const plainSchema = JSON.parse(
      JSON.stringify(
        Type.Object({
          quality: Type.Union([Type.Literal("substantive"), Type.Literal("low_content")]),
          stuck: Type.Boolean(),
        }),
      ),
    );

    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage('{"quality":"substantive","stuck":true}')]);

    const result = await runSubagent({
      request: {
        task: "Classify the reply",
        outputSchema: plainSchema,
        budget: { maxTurns: 1 },
      },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ quality: "substantive", stuck: true });
  });

  test("rejects output that fails a plain JSON Schema instead of throwing", async () => {
    const plainSchema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    } as unknown as TSchema;

    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage('{"ok":"not-a-boolean"}')]);

    const result = await runSubagent({
      request: { task: "Return the result", outputSchema: plainSchema, budget: { maxTurns: 1 } },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({
      status: "invalid_output",
      error: "Subagent output does not match the requested schema",
    });
  });

  test("reports invalid structured output without guessing JSON", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage('```json\n{"ok":true}\n```')]);

    const result = await runSubagent({
      request: { task: "Return the result", outputSchema: Type.Object({ ok: Type.Boolean() }) },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({
      status: "invalid_output",
      error: "Subagent output is not valid JSON",
    });
  });

  /**
   * The session's event stream always existed and nothing consumed it, so a
   * subagent was silent for its entire run — a step that legitimately took
   * four minutes was indistinguishable from a hang, and was reported as one.
   */
  test("reports what the run is doing as it happens", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);
    const activity: string[] = [];

    await runSubagent({
      request: { task: "Use echo", tools: ["echo"] },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
      onActivity: (line) => activity.push(line),
    });

    // The tool call is the part a reader can follow; naming it is the whole
    // point of the sink.
    expect(activity).toContain("echo");
    expect(activity.length).toBeGreaterThan(1);
  });

  test("a failing activity sink does not fail the run", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("done")]);

    const result = await runSubagent({
      request: { task: "Answer" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      onActivity: () => {
        throw new Error("sink exploded");
      },
    });

    // Progress display is a nicety; the answer is not.
    expect(result).toMatchObject({ status: "completed", output: "done" });
  });

  test("grants only explicitly requested tools", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const result = await runSubagent({
      request: { task: "Use echo", tools: ["echo"] },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
    });

    expect(result).toMatchObject({
      status: "completed",
      output: "done",
      turns: 2,
      toolCalls: 1,
      toolCallCounts: { echo: 1 },
    });
  });

  test("stops when the subagent exceeds its turn budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("should not run"),
    ]);

    const result = await runSubagent({
      request: { task: "Use echo", tools: ["echo"], budget: { maxTurns: 1 } },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
    });

    expect(result.status).toBe("budget_exceeded");
    expect(result.error).toContain("LLM calls");
    expect(result.text ?? "").not.toContain("should not run");
  });

  test("honors an already-aborted signal without calling the model", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("should not run")]);
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagent({
      request: { task: "Do not run", signal: controller.signal },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({ status: "cancelled", turns: 0 });
    expect(result.text).toBeUndefined();
  });

  test("tells a subagent with no tools that it has none", async () => {
    const { models, faux, model } = createFauxSetup();
    let systemPrompt = "";
    faux.setResponses([
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("analysed");
      },
    ]);

    await runSubagent({
      request: { task: "Assess the supplied notes", profile: "thinker" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
      profiles: THINKER_PROFILES,
    });

    // Told to "use granted tools" while holding none, a model narrates a tool
    // call as prose and hands that text back as its finding.
    expect(systemPrompt).toContain("You have NO tools in this run");
    expect(systemPrompt).toContain("Do not emit tool calls or tool-call syntax");
    expect(systemPrompt).not.toContain("Use them for any claim");
  });

  test("names the granted tools in the evidence policy", async () => {
    const { models, faux, model } = createFauxSetup();
    let systemPrompt = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "hi" })),
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("done");
      },
    ]);

    await runSubagent({
      request: { task: "Echo something", tools: ["echo"] },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
    });

    expect(systemPrompt).toContain("Your tools this run: echo.");
    expect(systemPrompt).not.toContain("You have NO tools");
  });

  test("fails when a profile's required tool was not used", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("I read it without tools")]);

    const result = await runSubagent({
      request: { task: "Read README", profile: "explorer" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
      profiles: new Map([
        [
          "explorer",
          {
            name: "explorer",
            description: "Evidence explorer",
            systemPrompt: "Use evidence.",
            tools: ["echo"],
            requiredTools: ["echo"],
          },
        ],
      ]),
    });

    expect(result).toMatchObject({
      status: "failed",
      toolCalls: 0,
      error: "Required tool not used: echo",
    });
  });

  test("completes when a profile's required tool was actually invoked", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "README" })),
      fauxAssistantMessage("verified"),
    ]);

    const result = await runSubagent({
      request: { task: "Read README", profile: "explorer" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [echoTool],
      profiles: new Map([
        [
          "explorer",
          {
            name: "explorer",
            description: "Evidence explorer",
            systemPrompt: "Use evidence.",
            tools: ["echo"],
            requiredTools: ["echo"],
          },
        ],
      ]),
    });

    expect(result).toMatchObject({
      status: "completed",
      output: "verified",
      toolCalls: 1,
    });
  });

  test("reports unknown requested tools as a failed result without starting the subagent", async () => {
    const { models, model } = createFauxSetup();

    const result = await runSubagent({
      request: { task: "Use a missing tool", tools: ["missing"] },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "Unknown or unavailable subagent tool: missing",
      turns: 0,
    });
  });

  test("reports invalid subagent budgets as a failed result without starting the subagent", async () => {
    const { models, model } = createFauxSetup();

    const result = await runSubagent({
      request: { task: "Invalid budget", budget: { maxTurns: 0 } },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({ status: "failed", turns: 0 });
    expect(result.error).toContain("budget.maxTurns must be a positive integer");
  });

  test("reports an empty final response as failed instead of completed", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("")]);

    const result = await runSubagent({
      request: { task: "Say something" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "Subagent produced no text output",
    });
  });

  test("a task failing validation cannot orphan batch siblings", async () => {
    // The second task is whitespace-only, which fails request validation. As a
    // failed result (not a rejection) it must not tear down the Promise chain
    // that the first task's live run hangs on.
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("sibling done")]);
    const tool = createSubagentTool(
      (request) =>
        runSubagent({
          request,
          defaultModel: model,
          thinkingLevel: "off",
          models,
          workspaceDir: dir,
          availableTools: [],
          profiles: THINKER_PROFILES,
        }),
      THINKER_MENU,
    );

    const result = await tool.execute("batch", {
      profile: "thinker",
      tasks: [{ task: "Do the real work" }, { task: "   " }],
    });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("[1] sibling done");
    expect(text).toContain("[2] Subagent failed");
    expect(text).toContain("non-empty task");
  });

  test("prevents a subagent tool from recursively starting another subagent", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("nested", {})),
      fauxAssistantMessage("outer complete"),
    ]);
    let nestedError = "";
    const nestedTool: AgentTool = {
      name: "nested",
      label: "nested",
      description: "Attempt a nested subagent run",
      parameters: Type.Object({}),
      execute: async () => {
        const nested = await runSubagent({
          request: { task: "inner" },
          defaultModel: model,
          thinkingLevel: "off",
          models,
          workspaceDir: dir,
          availableTools: [],
        });
        if (nested.status === "failed") nestedError = nested.error ?? "";
        return { content: [{ type: "text", text: nestedError }], details: {} };
      },
    };

    const result = await runSubagent({
      request: { task: "Try nesting", tools: ["nested"] },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [nestedTool],
    });

    expect(result.status).toBe("completed");
    expect(nestedError).toBe("Nested api.subagent.run calls are not allowed");
  });

  test("reports spend through onUsage exactly once, including never-reject failures", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("spent")]);

    const usageCalls: SubagentUsage[] = [];
    const result = await runSubagent({
      request: { task: "Do focused work" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      onUsage: (usage) => {
        usageCalls.push(usage);
      },
    });
    expect(result.status).toBe("completed");
    expect(usageCalls).toEqual([result.usage]);

    // A run that fails before the session even starts still reports once.
    const failureCalls: SubagentUsage[] = [];
    const failure = await runSubagent({
      request: { task: "Do focused work", tools: ["missing-tool"] },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      onUsage: (usage) => {
        failureCalls.push(usage);
      },
    });
    expect(failure.status).toBe("failed");
    expect(failureCalls).toEqual([failure.usage]);
  });

  test("a throwing onUsage listener does not break the never-reject contract", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("still fine")]);

    const result = await runSubagent({
      request: { task: "Do focused work" },
      defaultModel: model,
      thinkingLevel: "off",
      models,
      workspaceDir: dir,
      availableTools: [],
      onUsage: () => {
        throw new Error("listener boom");
      },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBe("still fine");
  });
});
