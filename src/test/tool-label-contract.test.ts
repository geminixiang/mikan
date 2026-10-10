import { describe, expect, test, vi } from "vitest";
import { runTestTool, TEST_CONTEXT as TODO_CONTEXT } from "./tool-api.js";
import { createMikanTools } from "../harness/tools/index.js";
import { createGithubToolPack } from "../adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "../adapters/github/types.js";
import { ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { EventStore } from "../events/index.js";
import { createOfficeAddress } from "../office/index.js";

function mockGithubOps(): PlatformGithubOps {
  return {
    createPullRequest: vi.fn(),
    getChecks: vi.fn(),
    getJobLog: vi.fn(),
    replyToReviewThread: vi.fn(),
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
  test("the assembled browser tool runs agent-browser through the run's environment", async () => {
    const env = new NodeExecutionEnv({ cwd: "/workspace" });
    const exec = vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
      const data = { path: "/workspace/scratch/page.png" };
      options?.onOutput?.(JSON.stringify({ success: true, data, error: null }), context, {
        stream: "stdout",
      });
      return ok({ exitCode: 0 });
    });
    const { tools } = createMikanTools(() => env, mockEventStore(), {
      sandbox: { type: "container", container: "office-test" },
    });
    const browser = tools.find((tool) => tool.name === "jev_browser");
    expect(browser).toBeDefined();
    expect((browser!.parameters as { required: string[] }).required).toContain("label");
    await runTestTool(
      browser!,
      {
        label: "Capture sandbox browser",
        url: "https://example.com",
        commands: [["screenshot", "/workspace/scratch/page.png"]],
      },
      { env },
    );
    const session = expect.stringMatching(/^mikan-jb-/);
    expect(exec.mock.calls.map(([command]) => command)).toEqual([
      ["agent-browser", "--session", session, "open", "https://example.com", "--json"],
      [
        "agent-browser",
        "--session",
        session,
        "screenshot",
        "/workspace/scratch/page.png",
        "--json",
      ],
    ]);
    expect(
      exec.mock.calls.every(([, , context]) => context.abortSignal === TODO_CONTEXT.abortSignal),
    ).toBe(true);
  });

  test("across the full assembled tool list, including the GitHub platform pack", () => {
    const { tools } = createMikanTools(
      () => undefined,
      mockEventStore(),
      { sandbox: { type: "host" } },
      [createGithubToolPack(mockGithubOps(), new Set(["triage", "push"]))],
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
