import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MikanModels } from "../src/harness/index.js";
import { describe, expect, test } from "vitest";
import { resolveConfiguredModel } from "../src/model-registry.js";

function withTempRegistry(config: unknown): MikanModels {
  const dir = mkdtempSync(join(tmpdir(), "mikan-model-registry-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify(config));
  return MikanModels.create({
    authPath: join(dir, "auth.json"),
    modelsJsonPath: join(dir, "models.json"),
  });
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
      const registry = MikanModels.create({
        authPath: join(dir, "auth.json"),
        modelsJsonPath: join(dir, "models.json"),
      });

      expect(() => resolveConfiguredModel(registry, "missing", "model")).toThrow(
        'Unknown model "missing/model"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
