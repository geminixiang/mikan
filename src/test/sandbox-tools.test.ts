import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  TODO_CONTEXT,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  type AgentHarnessToolInvocation,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { HostExecutor } from "../sandbox/host.js";
import { createSandboxExecutionEnv } from "../harness/execution-env.js";
import { createSandboxTools, type MikanHarnessTool } from "../harness/tools/pi-tools.js";

/**
 * The pi-native read/write/edit/bash tools, exercised the way the harness runs
 * them: through the sandbox-backed env supplied as `toolContext`, with mikan's
 * `label` parameter accepted alongside pi's own schema.
 */

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("sandbox tools", () => {
  let dir: string;
  let env: ExecutionEnv;
  let tools: MikanHarnessTool[];

  const tool = (name: string): MikanHarnessTool => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };

  const run = async (name: string, params: Record<string, unknown>) => {
    const candidate = tool(name);
    const validated = validateToolArguments(candidate, {
      type: "toolCall",
      id: "call-1",
      name,
      arguments: params,
    });
    return candidate.execute("call-1", validated, () => {}, { env }, invocation, TODO_CONTEXT);
  };

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-sandbox-tools-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    env = createSandboxExecutionEnv(new HostExecutor(), "host", dir);
    tools = createSandboxTools();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("exposes the four tools and mikan's label parameter", () => {
    expect(tools.map((candidate) => candidate.name).toSorted()).toEqual([
      "bash",
      "edit",
      "read",
      "write",
    ]);
    for (const candidate of tools) {
      const properties = (candidate.parameters as { properties?: Record<string, unknown> })
        .properties;
      expect(properties).toHaveProperty("label");
    }
  });

  test("preserves native schemas when adding an optional label", () => {
    for (const native of [
      createReadTool(),
      createWriteTool(),
      createEditTool(),
      createBashTool(),
    ]) {
      const { properties, ...schema } = tool(native.name).parameters as {
        properties: Record<string, unknown>;
      };
      const { properties: nativeProperties, ...nativeSchema } = native.parameters;
      expect(schema).toEqual(nativeSchema);
      expect(properties).toEqual(expect.objectContaining(nativeProperties));
    }
  });

  test("rejects native tools without an explicit execution env", async () => {
    await expect(
      tool("read").execute(
        "call-1",
        { path: "README.md" },
        () => {},
        undefined!,
        invocation,
        TODO_CONTEXT,
      ),
    ).rejects.toThrow("requires toolContext.env");
  });

  test("write then read round-trips content", async () => {
    const path = join(dir, "notes.txt");
    const written = await run("write", { path, content: "hello 橘子", label: "write notes" });
    expect(textOf(written as never)).toContain("Successfully");
    expect(readFileSync(path, "utf-8")).toBe("hello 橘子");

    const read = await run("read", { path, label: "read notes" });
    expect(textOf(read as never)).toContain("hello 橘子");
  });

  test("edit replaces unique text and reports a diff", async () => {
    const path = join(dir, "app.ts");
    writeFileSync(path, "const a = 1;\nconst b = 2;\n");

    const result = await run("edit", {
      path,
      label: "bump a",
      edits: [{ oldText: "const a = 1;", newText: "const a = 42;" }],
    });

    expect(readFileSync(path, "utf-8")).toBe("const a = 42;\nconst b = 2;\n");
    expect((result as { details?: { diff?: string } }).details?.diff).toBeTruthy();
  });

  test("edit applies multiple non-overlapping edits", async () => {
    const path = join(dir, "app.ts");
    writeFileSync(path, "one\ntwo\nthree\n");

    await run("edit", {
      path,
      label: "two edits",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "three", newText: "3" },
      ],
    });

    expect(readFileSync(path, "utf-8")).toBe("1\ntwo\n3\n");
  });

  test("edit preserves CRLF line endings", async () => {
    const path = join(dir, "win.txt");
    writeFileSync(path, "alpha\r\nbeta\r\ngamma\r\n");

    await run("edit", {
      path,
      label: "edit crlf",
      edits: [{ oldText: "beta", newText: "BETA" }],
    });

    expect(readFileSync(path, "utf-8")).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  test("edit rejects a non-unique oldText", async () => {
    const path = join(dir, "dup.txt");
    writeFileSync(path, "foo\nfoo\n");

    await expect(
      run("edit", { path, label: "dup", edits: [{ oldText: "foo", newText: "bar" }] }),
    ).rejects.toThrow(/occurrences/);
  });

  test("bash runs a command and returns its output", async () => {
    const result = await run("bash", { command: "echo hello-from-bash", label: "say hi" });
    expect(textOf(result as never)).toContain("hello-from-bash");
  });

  test("read and bash accept native minimal arguments without label or optional fields", async () => {
    const path = join(dir, "minimal.txt");
    writeFileSync(path, "minimal read");
    expect(textOf(await run("read", { path }))).toContain("minimal read");
    expect(textOf(await run("bash", { command: "printf minimal-bash" }))).toContain("minimal-bash");
  });

  test("bash reports a non-zero exit", async () => {
    await expect(run("bash", { command: "exit 7", label: "fail" })).rejects.toThrow(/exit/i);
  });
});
