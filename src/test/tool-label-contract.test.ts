import { describe, expect, test, vi } from "vitest";
import { createMikanTools } from "../harness/tools/index.js";
import { createGithubToolPack } from "../adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "../adapters/github/types.js";
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
