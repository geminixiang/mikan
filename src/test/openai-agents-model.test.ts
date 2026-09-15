import { Agent, run, tool } from "@openai/agents";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { MikanModels } from "../harness/models.js";
import { PiAiAgentsModel } from "../harness/openai/pi-model.js";

function response(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 0,
      reasoning: 2,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("PiAiAgentsModel", () => {
  it("lets the OpenAI Agents SDK run tools through a pi-ai-backed model", async () => {
    const models = MikanModels.create({ modelsJsonPath: "/does/not/exist" });
    const selectedModel = models.getAll()[0];
    if (!selectedModel) throw new Error("Expected the built-in pi-ai model catalog");

    const complete = vi
      .spyOn(models.models, "completeSimple")
      .mockResolvedValueOnce(
        response(
          [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "hi" } }],
          "toolUse",
        ),
      )
      .mockResolvedValueOnce(response([{ type: "text", text: "tool completed" }], "stop"));
    const execute = vi.fn(({ value }: { value: string }) => `echo:${value}`);
    const echo = tool({
      name: "echo",
      description: "Echo text",
      strict: false,
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      execute,
    });
    const model = new PiAiAgentsModel(models, selectedModel);
    const agent = new Agent({
      name: "mikan-test",
      instructions: "Be useful",
      model,
      tools: [echo],
    });

    const result = await run(agent, "hello", { maxTurns: 3 });

    expect(result.finalOutput).toBe("tool completed");
    expect(execute).toHaveBeenCalledWith(
      { value: "hi" },
      expect.anything(),
      expect.objectContaining({ toolCall: expect.objectContaining({ callId: "call-1" }) }),
    );
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[1]).toMatchObject({
      systemPrompt: "Be useful",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "echo" }],
    });
    expect(complete.mock.calls[1]?.[1]).toMatchObject({
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "echo", arguments: { value: "hi" } }],
        },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "echo",
          content: [{ type: "text", text: "echo:hi" }],
        },
      ],
    });
  });

  it("maps pi-ai reasoning, text, tool calls, and usage to Agents SDK output", async () => {
    const models = MikanModels.create({ modelsJsonPath: "/does/not/exist" });
    const selectedModel = models.getAll()[0];
    if (!selectedModel) throw new Error("Expected the built-in pi-ai model catalog");
    vi.spyOn(models.models, "completeSimple").mockResolvedValue(
      response(
        [
          { type: "thinking", thinking: "considering" },
          { type: "text", text: "answer" },
          { type: "toolCall", id: "call-2", name: "read", arguments: { path: "x" } },
        ],
        "toolUse",
      ),
    );

    const result = await new PiAiAgentsModel(models, selectedModel).getResponse({
      input: "question",
      modelSettings: {},
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false,
    });

    expect(result.output).toEqual([
      {
        type: "reasoning",
        content: [{ type: "input_text", text: "considering" }],
        rawContent: [{ type: "reasoning_text", text: "considering" }],
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "answer" }],
      },
      {
        type: "function_call",
        callId: "call-2",
        name: "read",
        arguments: '{"path":"x"}',
        status: "completed",
      },
    ]);
    expect(result.usage).toMatchObject({
      requests: 1,
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
    });
  });
});
