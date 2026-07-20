import { describe, expect, test, vi } from "vitest";
import { createSandboxTool } from "../src/tools/sandbox.js";

describe("createSandboxTool", () => {
  test("sets limits for the current image sandbox conversation", async () => {
    const setLimits = vi.fn().mockResolvedValue({
      limits: { cpus: "2", memory: "4g" },
      boosted: false,
    });
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits,
      },
    });

    setSandboxContext({ conversationId: "C123", userId: "U123" });
    const result = await tool.execute("tool-call", {
      action: "set",
      cpus: "2",
      memory: "4g",
    });

    expect(setLimits).toHaveBeenCalledWith("c123-588a5f4edc2e", { cpus: "2", memory: "4g" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("CPU 2 / Memory 4g"),
    });
  });

  test("reports status for the current image sandbox conversation", async () => {
    const getLimitStatus = vi.fn().mockReturnValue({
      limits: { cpus: "0.5", memory: "1g" },
      boosted: false,
    });
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
      resourceController: {
        getLimitStatus,
        setLimits: vi.fn(),
      },
    });

    setSandboxContext({ conversationId: "C123", userId: "U123" });
    const result = await tool.execute("tool-call", { action: "status" });

    expect(getLimitStatus).toHaveBeenCalledWith("c123-588a5f4edc2e");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("CPU 0.5 / Memory 1g"),
    });
  });

  test("sets limits for the current Gondolin conversation", async () => {
    const setLimits = vi.fn().mockResolvedValue({
      limits: { cpus: "2", memory: "4g" },
      boosted: false,
    });
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "image", image: "test" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits,
      },
    });

    setSandboxContext({ conversationId: "C123", userId: "U123" });
    await tool.execute("tool-call", { action: "set", cpus: "2", memory: "4g" });

    expect(setLimits).toHaveBeenCalledWith("c123-588a5f4edc2e", { cpus: "2", memory: "4g" });
  });

  test("rejects set without limits", async () => {
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits: vi.fn(),
      },
    });

    setSandboxContext({ conversationId: "C123", userId: "U123" });
    await expect(tool.execute("tool-call", { action: "set" })).rejects.toThrow(
      "action=set requires cpus and/or memory",
    );
  });
});
