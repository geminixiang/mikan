import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createOfficeAddress } from "../src/office-address.js";
import type { MutableModels } from "@earendil-works/pi-ai";
import { MikanModels } from "../src/harness/index.js";
import { createEmbedder } from "../examples/embedder/index.js";

let workingDir: string;

beforeEach(() => {
  workingDir = join(
    tmpdir(),
    `mikan-embedder-example-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workingDir, { recursive: true });
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
});

function createFauxModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
  const stateDir = join(workingDir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
  process.env.MIKAN_STATE_DIR = stateDir;

  const authPath = join(stateDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
  const models = MikanModels.create({
    authPath,
    modelsJsonPath: join(stateDir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

describe("examples/embedder", () => {
  test("constructs from the public surface without vault or portal token stores", () => {
    const embedder = createEmbedder({ workingDir, write: () => {} });
    expect(embedder.runtime.isRunning(createOfficeAddress("slack", "embedder"), "embedder")).toBe(
      false,
    );
    expect(embedder.runtime.getRunningSessions()).toEqual([]);
  });

  test("one stdin line round-trips through handleEvent to stdout", async () => {
    const { models, faux } = createFauxModels();
    const outputs: string[] = [];
    const embedder = createEmbedder({ workingDir, models, write: (text) => outputs.push(text) });

    faux.setResponses([() => fauxAssistantMessage("embedded hello")]);
    await embedder.handleLine("hi there");

    expect(outputs.join("\n")).toContain("embedded hello");
    expect(embedder.runtime.isRunning(createOfficeAddress("slack", "embedder"), "embedder")).toBe(
      false,
    );
  });

  test("portal commands reply not-configured instead of crashing", async () => {
    createFauxModels();
    const outputs: string[] = [];
    const embedder = createEmbedder({ workingDir, write: (text) => outputs.push(text) });

    await embedder.handleLine("/login");

    expect(outputs.join("\n")).toContain("Login is not configured");
  });
});
