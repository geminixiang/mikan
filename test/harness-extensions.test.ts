import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectExtensionContributions,
  loadMikanExtensions,
  type ExtensionLoadResult,
} from "../src/harness/extensions.js";
import * as log from "../src/log.js";

let dir: string;

beforeEach(() => {
  dir = join(
    tmpdir(),
    `harness-extensions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadMikanExtensions", () => {
  test("returns empty result when the directory does not exist", async () => {
    const result = await loadMikanExtensions(join(dir, "missing"));
    expect(result.extensions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("loads a well-formed extension exporting a default with a name", async () => {
    writeFileSync(join(dir, "good.js"), `export default { name: "good-ext", tools: () => [] };\n`);

    const result = await loadMikanExtensions(dir);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].module.name).toBe("good-ext");
  });

  test("loads an extension from a directory's index.js", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "nested", "index.js"), `export default { name: "nested-ext" };\n`);

    const result = await loadMikanExtensions(dir);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].module.name).toBe("nested-ext");
  });

  test("records an error for a module missing a name, without blocking other extensions", async () => {
    writeFileSync(join(dir, "bad.js"), `export default { tools: () => [] };\n`);
    writeFileSync(join(dir, "good.js"), `export default { name: "good-ext" };\n`);

    const result = await loadMikanExtensions(dir);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].module.name).toBe("good-ext");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toContain("bad.js");
  });

  test("records an error for a module that throws on import, without blocking other extensions", async () => {
    writeFileSync(join(dir, "throws.js"), `throw new Error("boom during import");\n`);
    writeFileSync(join(dir, "good.js"), `export default { name: "good-ext" };\n`);

    const result = await loadMikanExtensions(dir);
    expect(result.extensions).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("boom during import");
  });
});

describe("collectExtensionContributions", () => {
  test("collects tools contributed by a well-behaved extension", async () => {
    const tool = {
      name: "noop",
      label: "noop",
      description: "does nothing",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _args: unknown, _signal?: AbortSignal) => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: undefined,
      }),
    };
    const result: ExtensionLoadResult = {
      extensions: [{ path: "/x.js", module: { name: "x", tools: () => [tool] } }],
      errors: [],
    };

    const collected = await collectExtensionContributions(result, { log });
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0].name).toBe("noop");
    expect(collected.commands).toEqual([]);
  });

  test("isolates a throwing tools() factory without affecting other extensions", async () => {
    const goodTool = {
      name: "noop",
      label: "noop",
      description: "does nothing",
      parameters: Type.Object({}),
      execute: async (_toolCallId: string, _args: unknown, _signal?: AbortSignal) => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: undefined,
      }),
    };
    const result: ExtensionLoadResult = {
      extensions: [
        {
          path: "/broken.js",
          module: {
            name: "broken",
            tools: () => {
              throw new Error("factory exploded");
            },
          },
        },
        { path: "/good.js", module: { name: "good", tools: () => [goodTool] } },
      ],
      errors: [],
    };

    const collected = await collectExtensionContributions(result, { log });
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0].name).toBe("noop");
  });

  test("wraps a throwing command handler so tryHandle() never throws", async () => {
    const result: ExtensionLoadResult = {
      extensions: [
        {
          path: "/cmd.js",
          module: {
            name: "cmd-ext",
            commands: () => [
              {
                tryHandle: async () => {
                  throw new Error("handler exploded");
                },
              },
            ],
          },
        },
      ],
      errors: [],
    };

    const collected = await collectExtensionContributions(result, { log });
    expect(collected.commands).toHaveLength(1);
    await expect(collected.commands[0].tryHandle({} as never)).resolves.toBe(false);
  });
});
