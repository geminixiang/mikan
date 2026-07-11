import { describe, expect, test } from "vitest";
import { createReactTool } from "../src/tools/react.js";

describe("createReactTool", () => {
  test("calls the react function with the emoji and confirms", async () => {
    const { tool, setReactFunction } = createReactTool();
    const calls: string[] = [];
    setReactFunction(async (emoji) => {
      calls.push(emoji);
    });

    const result = await tool.execute("t1", { emoji: "eyes" });
    expect(calls).toEqual(["eyes"]);
    expect(result.content[0]).toMatchObject({ text: "Reacted with :eyes:" });
  });

  test("throws when reactions are unavailable in this context", async () => {
    const { tool } = createReactTool();
    await expect(tool.execute("t1", { emoji: "eyes" })).rejects.toThrow(/not supported/i);
  });

  test("unsetting the react function disables the tool again", async () => {
    const { tool, setReactFunction } = createReactTool();
    setReactFunction(async () => {});
    await tool.execute("t1", { emoji: "+1" });
    setReactFunction(null);
    await expect(tool.execute("t2", { emoji: "+1" })).rejects.toThrow(/not supported/i);
  });
});
