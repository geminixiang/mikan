import { describe, expect, test } from "vitest";
import {
  AgentSandboxExecutor,
  configureAgentSandboxRuntime,
  parseSandboxArg,
} from "../src/sandbox/index.js";

describe("AgentSandboxExecutor", () => {
  test("parses a warm pool and exposes the mounted workspace path", () => {
    const config = parseSandboxArg("agent-sandbox:mikan-kata");
    expect(config).toEqual({
      type: "agent-sandbox",
      warmpool: "mikan-kata",
      resourceKey: "default",
      mounts: [],
    });

    const executor = new AgentSandboxExecutor(
      config as Extract<typeof config, { type: "agent-sandbox" }>,
    );
    expect(executor.getWorkspacePath("/host/workspace")).toBe("/workspace");
    expect(executor.getPathContext("/host/workspace")).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
  });

  test("rejects a non-Kata runtime class", () => {
    expect(() =>
      configureAgentSandboxRuntime({
        namespace: "mikan",
        runtimeClassName: "runc",
      }),
    ).toThrow("requires runtimeClassName 'kata-qemu'");
  });
});
