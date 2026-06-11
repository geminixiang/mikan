import { describe, expect, test, vi } from "vitest";
import { createAttachTool } from "../src/adapters/slack/tools/attach.js";

describe("attach tool", () => {
  test("passes relative paths through for runtime workspace resolution", async () => {
    const { tool, setUploadFunction } = createAttachTool();
    const upload = vi.fn(async () => {});
    setUploadFunction(upload);

    await tool.execute(
      "call-1",
      { label: "share report", path: "gpt-5-mini.md" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(upload).toHaveBeenCalledWith("gpt-5-mini.md", "gpt-5-mini.md");
  });
});
