import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MikanModels } from "../src/harness/index.js";
import { describe, expect, test } from "vitest";

function withTempRegistry(config: unknown): MikanModels {
  const dir = mkdtempSync(join(tmpdir(), "mikan-model-registry-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify(config));
  return MikanModels.create({
    authPath: join(dir, "auth.json"),
    modelsJsonPath: join(dir, "models.json"),
  });
}

describe("MikanModels.resolve", () => {
  test("resolves custom models from models.json", () => {
    const registry = withTempRegistry({
      providers: {
        "agent-model": {
          api: "openai-completions",
          apiKey: "dev",
          baseUrl: "http://localhost:8080/v1",
          compat: {
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
            supportsStore: false,
          },
          models: [
            {
              id: "claude-opus-4-7",
              name: "Claude Opus 4.7",
              input: ["text", "image"],
              reasoning: true,
            },
          ],
        },
      },
    });

    const model = registry.resolve("agent-model", "claude-opus-4-7");

    expect(model.provider).toBe("agent-model");
    expect(model.id).toBe("claude-opus-4-7");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://localhost:8080/v1");
  });

  test("maps a production-shaped provider entry field-for-field (maxOutputTokens alias)", () => {
    // Mirrors the deployed models.json shape: inline apiKey, provider compat,
    // thinkingLevelMap, and the maxOutputTokens spelling for maxTokens.
    const registry = withTempRegistry({
      providers: {
        "agent-model": {
          api: "openai-completions",
          apiKey: "k",
          baseUrl: "http://10.0.0.1:8080/v1",
          compat: {
            supportsDeveloperRole: false,
            maxTokensField: "max_completion_tokens",
            supportsStore: false,
            supportsUsageInStreaming: true,
          },
          models: [
            {
              id: "chatgpt-gpt-5.5",
              name: "GPT-5.5",
              input: ["text", "image"],
              reasoning: true,
              thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
              contextWindow: 272000,
              maxOutputTokens: 128000,
              cost: { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 0 },
            },
          ],
        },
      },
    });

    const model = registry.resolve("agent-model", "chatgpt-gpt-5.5");
    expect(model.maxTokens).toBe(128000);
    expect(model.contextWindow).toBe(272000);
    expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh", minimal: "low" });
    expect(model.compat).toMatchObject({ maxTokensField: "max_completion_tokens" });
    expect(model.cost.input).toBe(5.0);
  });

  test("throws a clear error for unknown models", () => {
    const dir = mkdtempSync(join(tmpdir(), "mikan-empty-model-registry-"));
    try {
      const registry = MikanModels.create({
        authPath: join(dir, "auth.json"),
        modelsJsonPath: join(dir, "models.json"),
      });

      expect(() => registry.resolve("missing", "model")).toThrow('Unknown model "missing/model"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
