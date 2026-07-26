import { describe, expect, test } from "vitest";
import { parseModelCommand } from "../src/commands/model.js";

describe("model command parsing", () => {
  test("requires slash form", () => {
    expect(parseModelCommand("model openai/gpt-4o")).toBeNull();
  });

  test("parses a query without arguments", () => {
    expect(parseModelCommand("/model")).toEqual({});
  });

  test("parses provider/model", () => {
    expect(parseModelCommand("/pi-model openai/gpt-4o")).toEqual({
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: undefined,
    });
  });

  test("parses provider/model:thinking shorthand", () => {
    expect(parseModelCommand("/pi-model openai/gpt-5.6:max")).toEqual({
      provider: "openai",
      model: "gpt-5.6",
      thinkingLevel: "max",
    });
  });

  test("rejects a bare argument instead of treating it as a query", () => {
    expect(parseModelCommand("/model foo")).toEqual({ error: "invalid_spec" });
  });

  test("rejects an empty model", () => {
    expect(parseModelCommand("/pi-model provider/")).toEqual({ error: "invalid_spec" });
  });

  test("rejects an unknown thinking suffix", () => {
    expect(parseModelCommand("/pi-model openrouter/openai/gpt-4o:extended")).toEqual({
      error: "unknown_thinking_level",
    });
  });
});
