import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { MikanModels } from "../harness/index.js";
import { describe, expect, test, vi } from "vitest";

function withTempRegistry(config: unknown): MikanModels {
  const dir = mkdtempSync(join(tmpdir(), "mikan-model-registry-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify(config));
  return MikanModels.create({
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
        modelsJsonPath: join(dir, "models.json"),
      });

      expect(() => registry.resolve("missing", "model")).toThrow('Unknown model "missing/model"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MikanModels.getApiKeyForProvider", () => {
  test("resolves provider auth without enumerating models and tolerates auth failure", async () => {
    const registry = withTempRegistry({
      providers: {
        custom: {
          api: "openai-completions",
          apiKey: "custom-key",
          models: [{ id: "custom-model" }],
        },
      },
    });
    const models = (registry as unknown as { models: MutableModels }).models;
    const getModels = vi.spyOn(models, "getModels");
    const getAuth = vi.spyOn(models, "getAuth");

    await expect(registry.getApiKeyForProvider("custom")).resolves.toBe("custom-key");
    expect(getAuth).toHaveBeenCalledWith("custom");
    expect(getModels).not.toHaveBeenCalled();
    await expect(registry.getApiKeyForProvider("missing")).resolves.toBeUndefined();

    getAuth.mockRejectedValueOnce(new Error("auth check failed"));
    await expect(registry.getApiKeyForProvider("custom")).resolves.toBeUndefined();
  });
});

describe("MikanModels.getAvailable", () => {
  test("delegates provider filtering and isolates one provider failure", async () => {
    const registry = withTempRegistry({
      providers: {
        available: {
          api: "openai-completions",
          apiKey: "available-key",
          models: [{ id: "available-model", name: "Available", input: ["text"] }],
        },
        broken: {
          api: "openai-completions",
          apiKey: "broken-key",
          models: [{ id: "broken-model", name: "Broken", input: ["text"] }],
        },
      },
    });
    const models = (registry as unknown as { models: MutableModels }).models;
    const availableModel = registry.resolve("available", "available-model");
    const getAvailable = vi.spyOn(models, "getAvailable").mockImplementation((providerId) => {
      if (providerId === "broken") return Promise.reject(new Error("auth check failed"));
      if (providerId === "available") return Promise.resolve([availableModel]);
      return Promise.resolve([]);
    });

    const available = await registry.getAvailable();

    expect(available).toContain(availableModel);
    expect(available.some((model) => model.provider === "broken")).toBe(false);
    expect(getAvailable).toHaveBeenCalledWith("available");
    expect(getAvailable).toHaveBeenCalledWith("broken");
  });
});
