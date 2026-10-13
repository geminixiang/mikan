import { expect, test, vi } from "vitest";
import { createCodemodeTool } from "../harness/tools/codemode.js";
import { runTestTool } from "./tool-api.js";

const deadlines = vi.hoisted(() => [] as Array<number | undefined>);

vi.mock("@earendil-works/pi-codemode", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-codemode")>();
  class RecordingSandbox extends original.CodemodeSandbox {
    constructor(options: ConstructorParameters<typeof original.CodemodeSandbox>[0]) {
      deadlines.push(options?.timeoutMs);
      super(options);
    }
  }
  return { ...original, CodemodeSandbox: RecordingSandbox };
});

function codemode() {
  return createCodemodeTool({
    tools: [],
    servers: [],
    executeNested: async (tool, call) => tool.execute(...call),
  });
}

test("a script without timeout_ms has no deadline, as in Pi; one with timeout_ms gets it", async () => {
  deadlines.length = 0;

  await runTestTool(codemode(), { label: "No deadline", code: 'text("ok");' });
  await runTestTool(codemode(), {
    label: "Own deadline",
    code: '// @options: {"timeout_ms": 1234}\ntext("ok");',
  });

  expect(deadlines).toEqual([Number.POSITIVE_INFINITY, 1234]);
});
