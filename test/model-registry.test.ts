import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, test } from "vitest";
import { resolveConfiguredModel } from "../src/model-registry.js";

describe("resolveConfiguredModel", () => {
  test("resolves a known built-in model", () => {
    const models = builtinModels();

    const model = resolveConfiguredModel(models, "anthropic", "claude-3-5-haiku-latest");

    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("claude-3-5-haiku-latest");
  });

  test("throws a clear error for unknown models", () => {
    const models = builtinModels();

    expect(() => resolveConfiguredModel(models, "missing", "model")).toThrow(
      'Unknown model "missing/model"',
    );
  });
});
