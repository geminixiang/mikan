import { describe, expect, test, vi } from "vitest";
import { createAttachTool } from "../adapters/slack/tools/attach.js";

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

  test("appends the file extension to a custom title that lacks it", async () => {
    const { tool, setUploadFunction } = createAttachTool();
    const upload = vi.fn(async () => {});
    setUploadFunction(upload);

    await tool.execute(
      "call-1",
      { label: "share", path: "reports/summary.pdf", title: "Q3 Report" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(upload).toHaveBeenCalledWith("reports/summary.pdf", "Q3 Report.pdf");
  });

  test("keeps a custom title that already carries the extension", async () => {
    const { tool, setUploadFunction } = createAttachTool();
    const upload = vi.fn(async () => {});
    setUploadFunction(upload);

    await tool.execute(
      "call-1",
      { label: "share", path: "summary.pdf", title: "Q3.pdf" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(upload).toHaveBeenCalledWith("summary.pdf", "Q3.pdf");
  });

  test("throws when no upload function is configured", async () => {
    const { tool } = createAttachTool();

    await expect(
      tool.execute(
        "call-1",
        { label: "share", path: "file.txt" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Upload function not configured");
  });
});
