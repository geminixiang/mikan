import { describe, expect, test } from "vitest";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "../harness/tools/host-fn-tool.js";

describe("defineHostFnTool", () => {
  test("injects a required label parameter into any caller's schema", () => {
    const { tool } = defineHostFnTool({
      name: "example",
      description: "example tool",
      parameters: Type.Object({ foo: Type.String() }),
      unavailable: "unavailable",
      run: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
    });

    const schema = tool.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("label");
    expect(schema.properties).toHaveProperty("label");
    // The caller's own required fields survive alongside the injected one.
    expect(schema.required).toContain("foo");
  });

  test("strips label before the run body sees the arguments", async () => {
    let seenArgs: unknown;
    const { tool, setFn } = defineHostFnTool<() => void, ReturnType<typeof Type.Object>>({
      name: "example",
      description: "example tool",
      parameters: Type.Object({ foo: Type.String() }),
      unavailable: "unavailable",
      run: async (_fn, args) => {
        seenArgs = args;
        return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
      },
    });
    setFn(() => {});

    await tool.execute("call-1", { label: "Doing the thing", foo: "bar" });
    expect(seenArgs).toEqual({ foo: "bar" });
  });

  test("throws unavailable before running when no function is bound", async () => {
    const { tool } = defineHostFnTool({
      name: "example",
      description: "example tool",
      parameters: Type.Object({}),
      unavailable: "not bound yet",
      run: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
    });

    await expect(tool.execute("call-1", { label: "test" })).rejects.toThrow("not bound yet");
  });
});
