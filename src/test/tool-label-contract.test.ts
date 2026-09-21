import { describe, expect, test, vi } from "vitest";
import { createMikanTools } from "../harness/tools/index.js";
import { createGithubToolPack } from "../adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "../adapters/github/types.js";
import { HostExecutor } from "../sandbox/host.js";
import type { EventStore } from "../events/index.js";
import { createOfficeAddress } from "../office/index.js";

/**
 * Every model-facing tool schema must declare a required `label` parameter
 * (see AGENTS.md): the system prompt tells the model this unconditionally
 * ("Each tool requires a \"label\" parameter"), and `harness/presenter.ts`
 * renders it as the run's current step in every platform's progress lines.
 *
 * This drifted silently before: react and all six github_* tools were built
 * with `defineHostFnTool` before it added `label` itself, sandbox.ts and
 * generate-image.ts were written without it entirely, and jev_browser's
 * label was optional right up until its progress line rendered the doubled
 * "jev_browser · jev_browser" live on Slack because no label was supplied.
 * None of that showed up in TypeScript or in any existing test — a tool's
 * declared return type does not carry its runtime JSON Schema `required`
 * list, so only inspecting the assembled schemas here catches it.
 *
 * A markdown reminder is not enough on its own; this test is what actually
 * enforces it across every tool-adding code path, present and future.
 */

function mockGithubOps(): PlatformGithubOps {
  return {
    pushAndCreatePr: vi.fn(),
    getChecks: vi.fn(),
    getJobLog: vi.fn(),
    replyToReviewThread: vi.fn(),
    syncRepo: vi.fn(),
    readGithub: vi.fn(),
    manageIssue: vi.fn(),
  } as unknown as PlatformGithubOps;
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

/**
 * Tools whose schema intentionally has no required `label` — each is a
 * recorded design decision, not a loophole to reach for when a new tool's
 * label was simply forgotten:
 *  - `start_task` / `task_status`: use a fixed, self-explanatory tool-level
 *    `label` instead of a per-call one.
 *  - `event`: its optional `label` field describes the scheduled event
 *    being created, not this CRUD call itself.
 *  - `read` / `write` / `edit` / `bash`: pi-agent-core's own native tools,
 *    adapted via `withLabel` (`pi-tools.ts`), which keeps `label` optional
 *    on purpose so pi's own validation still accepts a call built without
 *    mikan's harness — the one place a tool crosses both ecosystems.
 */
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
      new HostExecutor(),
      mockEventStore(),
      undefined,
      [() => createGithubToolPack(mockGithubOps())],
      undefined,
    );

    const missing: string[] = [];
    for (const tool of tools) {
      if (EXEMPT_TOOL_NAMES.has(tool.name)) continue;
      const schema = tool.parameters as { required?: string[] };
      if (!schema.required?.includes("label")) missing.push(tool.name);
    }

    expect(missing).toEqual([]);
    // Sanity check the assertion actually exercised a non-trivial tool set,
    // so a future refactor that empties the list can't make this vacuous.
    expect(tools.length).toBeGreaterThan(10);
  });
});
