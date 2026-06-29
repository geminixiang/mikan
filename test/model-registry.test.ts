import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AuthStorage } from "../src/harness/auth-storage.js";
import { ModelRegistry } from "../src/harness/model-registry.js";
import { describe, expect, test } from "vitest";
import { resolveConfiguredModel } from "../src/model-registry.js";

function withTempRegistry(config: unknown): ModelRegistry {
  const dir = mkdtempSync(join(tmpdir(), "mikan-model-registry-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify(config));
  const authStorage = AuthStorage.create(join(dir, "auth.json"));
  return ModelRegistry.create(authStorage, join(dir, "models.json"));
}

describe("resolveConfiguredModel", () => {
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

    const model = resolveConfiguredModel(registry, "agent-model", "claude-opus-4-7");

    expect(model.provider).toBe("agent-model");
    expect(model.id).toBe("claude-opus-4-7");
    expect(model.api).toBe("openai-completions");
    expect(model.baseUrl).toBe("http://localhost:8080/v1");
  });

  test("throws a clear error for unknown models", () => {
    const dir = mkdtempSync(join(tmpdir(), "mikan-empty-model-registry-"));
    try {
      const registry = ModelRegistry.create(
        AuthStorage.create(join(dir, "auth.json")),
        join(dir, "models.json"),
      );

      expect(() => resolveConfiguredModel(registry, "missing", "model")).toThrow(
        'Unknown model "missing/model"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
