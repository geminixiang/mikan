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

  test("parses provider/model:thinking shorthand while retaining the full candidate", () => {
    expect(parseModelCommand("/pi-model openai/gpt-5.6:max")).toEqual({
      provider: "openai",
      model: "gpt-5.6",
      modelCandidate: "gpt-5.6:max",
      thinkingLevelCandidate: "max",
      thinkingLevel: "max",
    });
  });

  test("rejects a bare argument instead of treating it as a query", () => {
    expect(parseModelCommand("/model foo")).toEqual({ error: "invalid_spec" });
  });

  test("rejects an empty model", () => {
    expect(parseModelCommand("/pi-model provider/")).toEqual({ error: "invalid_spec" });
  });

  test("retains an unknown suffix for handler-side validation", () => {
    expect(parseModelCommand("/pi-model openrouter/openai/gpt-4o:extended")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o",
      modelCandidate: "openai/gpt-4o:extended",
      thinkingLevelCandidate: "extended",
    });
  });

  test("retains a colon model ID as the exact candidate", () => {
    expect(parseModelCommand("/model provider/model:2026-01")).toEqual({
      provider: "provider",
      model: "model",
      modelCandidate: "model:2026-01",
      thinkingLevelCandidate: "2026-01",
    });
  });
});
