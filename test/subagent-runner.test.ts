import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSubagent } from "../src/harness/subagent-runner.js";
import { MikanAgentSession, MikanModels, SessionStore } from "../src/harness/index.js";
import { createSubagentTool } from "../src/tools/subagent.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-extension-agent-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function createFauxSetup(): {
  models: MikanModels;
  faux: ReturnType<typeof fauxProvider>;
  model: Model<Api>;
} {
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
  const models = MikanModels.create({
    authPath,
    modelsJsonPath: join(dir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux, model: faux.getModel() as Model<Api> };
}

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo the input",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_toolCallId, args) => ({
    content: [{ type: "text", text: `echo: ${(args as { text: string }).text}` }],
  }),
};

describe("runSubagent", () => {
  test("backs the normal agent's subagent tool", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { task: "Delegate this" })),
      fauxAssistantMessage("delegated result"),
      fauxAssistantMessage("parent complete"),
    ]);
    const subagentTool = createSubagentTool((request) =>
      runSubagent({
        request,
        defaultModel: model,
        thinkingLevel: "off",
        models,
        workspaceDir: dir,
        availableTools: [],
      }),
    );
    const sessionStore = SessionStore.create(join(dir, "parent.jsonl"), dir);
    const parent = new MikanAgentSession({
      systemPrompt: "Delegate focused work when useful.",
      model,
      thinkingLevel: "off",
      tools: [subagentTool],
      models,
      sessionStore,
    });

    await parent.prompt("Use a subagent");

    const persisted = JSON.stringify(sessionStore.getEntries());
    expect(persisted).toContain("delegated result");
    expect(persisted).toContain("parent complete");
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

    expect(result).toMatchObject({ status: "completed", output: "done", turns: 2 });
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

  test("rejects unknown requested tools before starting the subagent", async () => {
    const { models, model } = createFauxSetup();

    await expect(
      runSubagent({
        request: { task: "Use a missing tool", tools: ["missing"] },
        defaultModel: model,
        thinkingLevel: "off",
        models,
        workspaceDir: dir,
        availableTools: [],
      }),
    ).rejects.toThrow("Unknown or unavailable subagent tool: missing");
  });

  test("rejects invalid subagent budgets before starting the subagent", async () => {
    const { models, model } = createFauxSetup();

    await expect(
      runSubagent({
        request: { task: "Invalid budget", budget: { maxTurns: 0 } },
        defaultModel: model,
        thinkingLevel: "off",
        models,
        workspaceDir: dir,
        availableTools: [],
      }),
    ).rejects.toThrow("budget.maxTurns must be a positive integer");
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
      description: "Attempt a nested subagent run",
      parameters: Type.Object({}),
      execute: async () => {
        try {
          await runSubagent({
            request: { task: "inner" },
            defaultModel: model,
            thinkingLevel: "off",
            models,
            workspaceDir: dir,
            availableTools: [],
          });
        } catch (err) {
          nestedError = err instanceof Error ? err.message : String(err);
        }
        return { content: [{ type: "text", text: nestedError }] };
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
});
