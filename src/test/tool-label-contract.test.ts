import { describe, expect, test, vi } from "vitest";
import { TODO_CONTEXT, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core";
import type { SandboxConfig } from "../sandbox/types.js";
import { createMikanTools } from "../harness/tools/index.js";
import { createGithubToolPack } from "../adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "../adapters/github/types.js";
import { HostExecutor } from "../sandbox/host.js";
import { createSandboxExecutionEnv } from "../harness/execution-env.js";
import type { EventStore } from "../events/index.js";
import { createOfficeAddress } from "../office/index.js";

function mockGithubOps(): PlatformGithubOps {
  return {
    pushAndCreatePr: vi.fn(),
    getChecks: vi.fn(),
    getJobLog: vi.fn(),
    replyToReviewThread: vi.fn(),
    syncRepo: vi.fn(),
    readGithub: vi.fn(),
    manageIssue: vi.fn(),
  };
}

function mockEventStore(): EventStore {
  return {
    address: createOfficeAddress("slack", "C1"),
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

const EXEMPT_TOOL_NAMES = new Set([
  "start_task",
  "task_status",
  "event",
  "read",
  "write",
  "edit",
  "bash",
]);

describe("every agent-facing tool requires a label parameter", () => {
  test.each<SandboxConfig>([
    { type: "host" },
    { type: "container", container: "office-test" },
    { type: "image", image: "test-image" },
    { type: "cloudflare", sandboxId: "test-sandbox" },
  ])("assembled browser tool uses the supplied $type executor", async (config) => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: { path: "/workspace/scratch/page.png" },
        error: null,
      }),
      stderr: "",
    });
    const executor = Object.assign(new HostExecutor(), { getSandboxConfig: () => config, exec });
    const { tools } = createMikanTools(executor, mockEventStore());
    const browser = tools.find((tool) => tool.name === "jev_browser");
    expect(browser).toBeDefined();
    expect((browser!.parameters as { required: string[] }).required).toContain("label");
    const invocation: AgentHarnessToolInvocation = {
      invocationId: "inv",
      operationId: "op",
      turnId: "turn",
      getMemo: async () => undefined,
      setMemo: async () => {},
    };
    await browser!.execute(
      "call",
      {
        label: "Capture sandbox browser",
        session: "office-browser",
        commands: [["screenshot", "/workspace/scratch/page.png"]],
      },
      () => {},
      { env: createSandboxExecutionEnv(executor, config.type, "/workspace") },
      invocation,
      TODO_CONTEXT,
    );
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "'agent-browser' '--session' 'office-browser' 'screenshot' '/workspace/scratch/page.png' '--json'",
      { timeout: 90, signal: TODO_CONTEXT.abortSignal },
    );
    vi.restoreAllMocks();
  });

  test("across the full assembled tool list, including the GitHub platform pack", () => {
    const { tools } = createMikanTools(
      new HostExecutor(),
      mockEventStore(),
      undefined,
      [createGithubToolPack(mockGithubOps())],
      undefined,
    );

    const missing: string[] = [];
    for (const tool of tools) {
      if (EXEMPT_TOOL_NAMES.has(tool.name)) continue;
      const schema = tool.parameters as { required?: string[] };
      if (!schema.required?.includes("label")) missing.push(tool.name);
    }

    expect(missing).toEqual([]);
    expect(tools.length).toBeGreaterThan(10);
  });
});
