import { describe, expect, test } from "vitest";
import { parseModelCommand } from "../packages/mikan/src/commands/model.js";

describe("model command parsing", () => {
  test("requires slash form", () => {
    expect(parseModelCommand("model openai/gpt-4o")).toBeNull();
  });

  test("parses provider/model", () => {
    expect(parseModelCommand("/pi-model openai/gpt-4o")).toEqual({
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: undefined,
    });
  });

  test("parses provider/model:thinking shorthand", () => {
    expect(parseModelCommand("/pi-model anthropic/claude-sonnet-4-6:off")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      thinkingLevel: "off",
    });
  });

  test("leaves unknown colon suffix as part of the model id", () => {
    expect(parseModelCommand("/pi-model openrouter/openai/gpt-4o:extended")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o:extended",
      thinkingLevel: undefined,
    });
  });
});
