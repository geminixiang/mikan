import { describe, expect, test, vi } from "vitest";
import { createOfficeAddress, officeKey } from "../office/index.js";
import { createSandboxTool } from "../tools/sandbox.js";

describe("createSandboxTool", () => {
  test("serializes state-changing limit operations", () => {
    const { tool } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
    });

    expect(tool.executionMode).toBe("sequential");
  });

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

    setSandboxContext({ address: createOfficeAddress("slack", "C123"), userId: "U123" });
    const result = await tool.execute("tool-call", {
      action: "set",
      cpus: "2",
      memory: "4g",
    });

    expect(setLimits).toHaveBeenCalledWith(officeKey(createOfficeAddress("slack", "C123")), {
      cpus: "2",
      memory: "4g",
    });
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

    setSandboxContext({ address: createOfficeAddress("slack", "C123"), userId: "U123" });
    const result = await tool.execute("tool-call", { action: "status" });

    expect(getLimitStatus).toHaveBeenCalledWith(officeKey(createOfficeAddress("slack", "C123")));
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("CPU 0.5 / Memory 1g"),
    });
  });

  test("sets limits for the current image-mode conversation", async () => {
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

    setSandboxContext({ address: createOfficeAddress("slack", "C123"), userId: "U123" });
    await tool.execute("tool-call", { action: "set", cpus: "2", memory: "4g" });

    expect(setLimits).toHaveBeenCalledWith(officeKey(createOfficeAddress("slack", "C123")), {
      cpus: "2",
      memory: "4g",
    });
  });

  test("rejects unsupported sandbox types even with a resource controller", async () => {
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "host" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits: vi.fn(),
      },
    });

    setSandboxContext({ address: createOfficeAddress("slack", "C123"), userId: "U123" });
    await expect(tool.execute("tool-call", { action: "status" })).rejects.toThrow(
      /only supports image:\*/,
    );
  });

  test("requires sandbox context before execution", async () => {
    const { tool } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits: vi.fn(),
      },
    });

    await expect(tool.execute("tool-call", { action: "status" })).rejects.toThrow(
      "Sandbox context not configured",
    );
  });

  test("rejects limit values containing shell metacharacters", async () => {
    const setLimits = vi.fn();
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits,
      },
    });

    setSandboxContext({ address: createOfficeAddress("slack", "C123"), userId: "U123" });
    await expect(
      tool.execute("tool-call", { action: "set", memory: "1g; rm -rf /" }),
    ).rejects.toThrow(/must not contain whitespace or shell metacharacters/);
    expect(setLimits).not.toHaveBeenCalled();
  });

  test("rejects set without limits", async () => {
    const { tool, setSandboxContext } = createSandboxTool({
      sandbox: { type: "image", image: "ubuntu:24.04" },
      resourceController: {
        getLimitStatus: vi.fn(),
        setLimits: vi.fn(),
      },
    });

    setSandboxContext({ address: createOfficeAddress("slack", "C123"), userId: "U123" });
    await expect(tool.execute("tool-call", { action: "set" })).rejects.toThrow(
      "action=set requires cpus and/or memory",
    );
  });
});
