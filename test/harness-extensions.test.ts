import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ExtensionRegistry, loadExtensions } from "../src/harness/index.js";
import type { Api, Model } from "@earendil-works/pi-ai";

let dir: string;

const testModel = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<Api>;

const context = {
  conversationId: "C123",
  workspaceDir: "/work",
  model: testModel,
  thinkingLevel: "off" as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-ext-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadExtensions", () => {
  test("activates default-export extensions and dispatches hooks", async () => {
    writeFileSync(
      join(dir, "blocker.mjs"),
      `export default function activate(api) {
        api.on("tool_call", ({ toolName }) => {
          if (toolName === "bash") return { block: true, reason: "no shell" };
        });
      }
      `,
    );

    const { registry, extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(extensions).toHaveLength(1);

    const blocked = await registry.emit("tool_call", {
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    expect(blocked).toEqual({ block: true, reason: "no shell" });

    const allowed = await registry.emit("tool_call", {
      toolCallId: "t2",
      toolName: "read",
      args: {},
    });
    expect(allowed).toBeUndefined();
  });

  test("supports named activate exports in index.js directories", async () => {
    const extDir = join(dir, "named");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.mjs"),
      `export const name = "named-extension";
      export function activate(api) {
        api.registerTool({ name: "custom_tool", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
      }
      `,
    );

    const { registry, extensions } = await loadExtensions({ dirs: [dir], context });
    expect(extensions[0]?.name).toBe("named-extension");
    expect(registry.getContributedTools().map((tool) => tool.name)).toEqual(["custom_tool"]);
  });

  test("collects module errors without failing the load", async () => {
    writeFileSync(join(dir, "broken.mjs"), "throw new Error('boom');\n");
    writeFileSync(join(dir, "no-activate.mjs"), "export const nothing = 1;\n");

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  test("missing directories are skipped", async () => {
    const { extensions, errors } = await loadExtensions({
      dirs: [join(dir, "missing")],
      context,
    });
    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe("ExtensionRegistry", () => {
  test("handler errors are isolated and later handlers still run", async () => {
    const registry = new ExtensionRegistry();
    registry.register("bad", "tool_call", () => {
      throw new Error("broken handler");
    });
    registry.register("good", "tool_call", () => ({ block: true }));

    const result = await registry.emit("tool_call", { toolCallId: "t", toolName: "x", args: {} });
    expect(result).toEqual({ block: true });
  });

  test("first non-undefined result wins", async () => {
    const registry = new ExtensionRegistry();
    registry.register("first", "tool_call", () => ({ block: false }));
    registry.register("second", "tool_call", () => ({ block: true }));

    const result = await registry.emit("tool_call", { toolCallId: "t", toolName: "x", args: {} });
    expect(result).toEqual({ block: false });
  });
});
