import type { TSchema } from "@sinclair/typebox";
import { describe, expect, test, vi } from "vitest";
import type {
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentUsage,
} from "../src/harness/types.js";
import { createSubagentTool } from "../src/tools/subagent.js";
import { SubagentSlotPool } from "../src/tools/subagent-slots.js";

type RunSubagent = <TOutputSchema extends TSchema | undefined = undefined>(
  request: SubagentRunRequest<TOutputSchema>,
) => Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>>;

function testUsage(tokens: number, costUsd = 0): SubagentUsage {
  return {
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: tokens,
    cost: {
      input: costUsd,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costUsd,
    },
  };
}

const TEST_PROFILES = new Map([["explorer", { description: "Evidence explorer" }]]);

/** Every subagent runs under a profile, so tests default to a single stub one. */
function makeTool(
  runSubagent: RunSubagent,
  profiles: ReadonlyMap<string, { description: string }> = TEST_PROFILES,
) {
  return createSubagentTool(runSubagent, profiles);
}

function completedRun(output: unknown): RunSubagent {
  return (async () => ({
    runId: "subagent-1",
    status: "completed",
    output,
    text: typeof output === "string" ? output : JSON.stringify(output),
    model: { provider: "test", id: "model" },
    turns: 1,
    toolCalls: 0,
    toolCallCounts: {},
    usage: testUsage(10),
    tokens: 10,
    costUsd: 0,
    durationMs: 5,
  })) as RunSubagent;
}

describe("subagent tool", () => {
  test("exposes an object-rooted function schema for OpenAI", () => {
    const tool = makeTool(completedRun("ok"));

    expect(tool.parameters.type).toBe("object");
  });

  test("rejects a subagent invocation without a mode", async () => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = makeTool(runSubagent);

    await expect(tool.execute("missing-mode", {})).rejects.toThrow(
      "Subagent requires exactly one of task, tasks, or dag",
    );
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test.each([
    ["task + tasks", { task: "one", tasks: [{ task: "two" }] }],
    ["task + dag", { task: "one", dag: { nodes: [{ id: "two", task: "two" }] } }],
    ["tasks + dag", { tasks: [{ task: "one" }], dag: { nodes: [{ id: "two", task: "two" }] } }],
    [
      "task + tasks + dag",
      {
        task: "one",
        tasks: [{ task: "two" }],
        dag: { nodes: [{ id: "three", task: "three" }] },
      },
    ],
  ])("rejects invocation with multiple modes (%s)", async (_label, params) => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = makeTool(runSubagent);

    await expect(tool.execute("multiple-modes", params)).rejects.toThrow(
      "Subagent requires exactly one of task, tasks, or dag",
    );
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("requires each DAG node to select an available profile", async () => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = makeTool(runSubagent);

    await expect(
      tool.execute("profiles", {
        dag: { nodes: [{ id: "explore", label: "Explore", task: "Read README" }] },
      }),
    ).rejects.toThrow("Subagent Explore must specify a profile (available: explorer)");
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("rejects a profile that is not on the menu", async () => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = makeTool(runSubagent);

    await expect(
      tool.execute("unknown", { task: "Read README", profile: "wanderer" }),
    ).rejects.toThrow("Unknown subagent profile: wanderer (available: explorer)");
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("forwards a selected profile", async () => {
    const runSubagent = vi.fn(completedRun("verified"));
    const tool = makeTool(runSubagent);

    await tool.execute("profile", { task: "Read README", profile: "explorer" });

    expect(runSubagent).toHaveBeenCalledWith(expect.objectContaining({ profile: "explorer" }));
  });

  test("a top-level profile covers every task and DAG node", async () => {
    const runSubagent = vi.fn(completedRun("verified"));
    const tool = makeTool(runSubagent);

    await tool.execute("shared-profile", {
      profile: "explorer",
      tasks: [{ task: "one" }, { task: "two" }],
    });

    expect(runSubagent).toHaveBeenCalledTimes(2);
    for (const [request] of runSubagent.mock.calls) {
      expect(request).toMatchObject({ profile: "explorer" });
    }
  });

  test("clamps a long label instead of rejecting the call", async () => {
    // A label is a display string the dashboard already truncates. Bounding it
    // in the schema let a 77-character title reject a whole four-node DAG, and
    // validation reported that by echoing every node's task text back.
    const runSubagent = vi.fn(completedRun("ok"));
    const tool = makeTool(runSubagent);
    // 78 chars: the label that once rejected a DAG now fits the bound intact.
    const titleLabel =
      "Execute DAG: clone, analyze risks, propose improvements, final recommendation";
    const oversizeLabel = "x".repeat(150);
    let seen: unknown;

    await tool.execute(
      "long-label",
      {
        profile: "explorer",
        tasks: [
          { task: "work", label: titleLabel },
          { task: "work", label: oversizeLabel },
        ],
      },
      undefined,
      (update) => {
        seen = update;
      },
    );

    const nodes = (seen as { details: { progress: { nodes: { label: string }[] } } }).details
      .progress.nodes;
    expect(nodes[0].label).toBe(titleLabel);
    expect(nodes[1].label).toBe(`${"x".repeat(99)}…`);
    expect(nodes[1].label).toHaveLength(100);
    expect(runSubagent).toHaveBeenCalledTimes(2);
  });

  test("offers no systemPrompt, tools, or model escape hatch", () => {
    const properties = (
      makeTool(completedRun("ok")).parameters as unknown as {
        properties: Record<string, unknown>;
      }
    ).properties;

    expect(properties.systemPrompt).toBeUndefined();
    expect(properties.tools).toBeUndefined();
    expect(properties.model).toBeUndefined();
    expect(properties.profile).toMatchObject({ enum: ["explorer"] });
  });

  test("states each profile's tool grant on the menu", () => {
    // A description alone reads as a stylistic constraint, so a model picks a
    // no-tool profile for work that needs tools and narrates the call instead.
    const tool = createSubagentTool(
      completedRun("ok"),
      new Map([
        ["researcher", { description: "Clones and inspects", tools: ["bash", "read"] }],
        ["analysis-only", { description: "Analyzes supplied input", tools: [] }],
      ]),
    );

    expect(tool.description).toContain("researcher [tools: bash, read] — Clones and inspects");
    expect(tool.description).toContain("analysis-only [no tools] — Analyzes supplied input");
  });

  test("refuses to build a subagent tool with no profiles", () => {
    expect(() => createSubagentTool(completedRun("ok"), new Map())).toThrow(
      "requires at least one subagent profile",
    );
  });

  test("supports abortable FIFO slot handoff and idempotent release", async () => {
    const pool = new SubagentSlotPool(1);
    const first = await pool.acquire();
    const aborted = new AbortController();
    aborted.abort();
    await expect(pool.acquire(aborted.signal)).rejects.toMatchObject({ name: "AbortError" });

    const queuedAbort = new AbortController();
    const cancelled = pool.acquire(queuedAbort.signal);
    const order: string[] = [];
    const second = pool.acquire().then((release) => {
      order.push("second");
      return release;
    });
    const third = pool.acquire().then((release) => {
      order.push("third");
      return release;
    });
    queuedAbort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    first();
    first();
    const secondRelease = await second;
    expect(order).toEqual(["second"]);
    expect(pool.inFlight).toBe(1);
    secondRelease();
    const thirdRelease = await third;
    expect(order).toEqual(["second", "third"]);
    thirdRelease();
    thirdRelease();
    expect(pool.inFlight).toBe(0);
  });

  test("cancels while queued without launching a subagent", async () => {
    const pool = new SubagentSlotPool(1);
    const release = await pool.acquire();
    const controller = new AbortController();
    const runSubagent = vi.fn(completedRun("should not run"));
    const tool = makeTool(runSubagent);
    const bounded = (request: SubagentRunRequest) =>
      (async () => {
        let slot: (() => void) | undefined;
        try {
          slot = await pool.acquire(request.signal);
        } catch {
          return {
            runId: "cancelled",
            status: "cancelled",
            model: { provider: "test", id: "model" },
            turns: 0,
            toolCalls: 0,
            toolCallCounts: {},
            usage: testUsage(0),
            tokens: 0,
            costUsd: 0,
            durationMs: 0,
          } as const;
        }
        try {
          return await runSubagent(request);
        } finally {
          slot();
        }
      })() as ReturnType<RunSubagent>;
    const boundedTool = makeTool(bounded as RunSubagent);
    const pending = boundedTool.execute(
      "queued",
      { profile: "explorer", task: "queued" },
      controller.signal,
    );
    controller.abort();
    const result = await pending;
    release();
    expect(result.details).toMatchObject({ status: "cancelled" });
    expect(runSubagent).not.toHaveBeenCalled();
    expect(tool.name).toBe("subagent");
  });

  test("a shared slot pool bounds fan-out across tool instances", async () => {
    let active = 0;
    let maxActive = 0;
    const runSubagent = (async (request: SubagentRunRequest) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {
        runId: request.task,
        status: "completed",
        output: "ok",
        text: "ok",
        model: { provider: "test", id: "model" },
        turns: 1,
        toolCalls: 0,
        toolCallCounts: {},
        usage: testUsage(1),
        tokens: 1,
        costUsd: 0,
        durationMs: 10,
      } as const;
    }) as RunSubagent;

    // Two conversations' tool instances draw from ONE process-wide account:
    // each could run 2 concurrently on its own, but the shared ceiling is 2.
    const shared = new SubagentSlotPool(2);
    const bounded = (async (request: SubagentRunRequest) => {
      const release = await shared.acquire(request.signal);
      try {
        return await runSubagent(request);
      } finally {
        release();
      }
    }) as RunSubagent;
    const toolA = makeTool(bounded);
    const toolB = makeTool(bounded);
    const params = { profile: "explorer", tasks: [{ task: "one" }, { task: "two" }] };

    await Promise.all([toolA.execute("a", params), toolB.execute("b", params)]);

    expect(maxActive).toBe(2);
    expect(shared.inFlight).toBe(0);
  });

  test("runs a bounded DAG in concurrent topological waves", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const runSubagent = (async (request: SubagentRunRequest) => {
      calls.push(request.task);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (request.task === "combine") {
        expect(request.input).toEqual({ dependencies: { a: "A", b: "B" } });
      }
      const output = request.task === "first" ? "A" : request.task === "second" ? "B" : "AB";
      return {
        runId: request.task,
        status: "completed",
        output,
        text: output,
        model: { provider: "test", id: "model" },
        turns: 1,
        toolCalls: 0,
        toolCallCounts: {},
        usage: testUsage(1),
        tokens: 1,
        costUsd: 0,
        durationMs: 10,
      } as const;
    }) as RunSubagent;
    const tool = makeTool(runSubagent);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "dag",
      {
        profile: "explorer",
        dag: {
          nodes: [
            { id: "a", task: "first" },
            { id: "b", task: "second" },
            { id: "combine", task: "combine", dependsOn: ["a", "b"] },
          ],
          maxConcurrency: 2,
        },
      },
      undefined,
      (update) => updates.push(update),
    );

    expect(maxActive).toBe(2);
    expect(calls.indexOf("combine")).toBeGreaterThan(calls.indexOf("second"));
    const finalNodes = (
      updates.at(-1) as { details: { progress: { nodes: { id: string; status: string }[] } } }
    ).details.progress.nodes;
    expect(finalNodes.map((node) => [node.id, node.status])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
      ["combine", "completed"],
    ]);
    expect(result.content).toEqual([{ type: "text", text: "[a] A\n\n[b] B\n\n[combine] AB" }]);
    expect(result.details).toMatchObject({
      mode: "dag",
      waves: [["a", "b"], ["combine"]],
    });
  });

  test("rejects cyclic DAGs before starting subagents", async () => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = makeTool(runSubagent);

    await expect(
      tool.execute("cycle", {
        profile: "explorer",
        dag: {
          nodes: [
            { id: "a", task: "a", dependsOn: ["b"] },
            { id: "b", task: "b", dependsOn: ["a"] },
          ],
        },
      }),
    ).rejects.toThrow("Subagent DAG contains a cycle");
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("rejects DAGs deeper than four waves", async () => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = makeTool(runSubagent);

    await expect(
      tool.execute("deep", {
        profile: "explorer",
        dag: {
          nodes: [
            { id: "a", task: "a" },
            { id: "b", task: "b", dependsOn: ["a"] },
            { id: "c", task: "c", dependsOn: ["b"] },
            { id: "d", task: "d", dependsOn: ["c"] },
            { id: "e", task: "e", dependsOn: ["d"] },
          ],
        },
      }),
    ).rejects.toThrow("Subagent DAG exceeds maximum depth 4");
    expect(runSubagent).not.toHaveBeenCalled();
  });

  test("skips descendants of failed DAG nodes while independent branches continue", async () => {
    const runSubagent = (async (request: SubagentRunRequest) => {
      if (request.task === "fail") {
        return {
          runId: "failed",
          status: "failed",
          model: { provider: "test", id: "model" },
          turns: 1,
          toolCalls: 0,
          toolCallCounts: {},
          usage: testUsage(1),
          tokens: 1,
          costUsd: 0,
          durationMs: 1,
          error: "boom",
        } as const;
      }
      return {
        runId: request.task,
        status: "completed",
        output: "ok",
        text: "ok",
        model: { provider: "test", id: "model" },
        turns: 1,
        toolCalls: 0,
        toolCallCounts: {},
        usage: testUsage(1),
        tokens: 1,
        costUsd: 0,
        durationMs: 1,
      } as const;
    }) as RunSubagent;
    const tool = makeTool(runSubagent);

    const result = await tool.execute("failure", {
      profile: "explorer",
      dag: {
        nodes: [
          { id: "root", task: "fail" },
          { id: "independent", task: "continue" },
          { id: "dependent", task: "skip", dependsOn: ["root"] },
        ],
      },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "[root] Subagent failed: boom\n\n[independent] ok\n\n[dependent] Subagent skipped: Dependency root did not complete",
      },
    ]);
  });

  test("runs a tasks batch concurrently and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    const runSubagent = (async (request: SubagentRunRequest) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {
        runId: request.task,
        status: "completed",
        output: request.task,
        text: request.task,
        model: { provider: "test", id: "model" },
        turns: 1,
        toolCalls: 0,
        toolCallCounts: {},
        usage: testUsage(1),
        tokens: 1,
        costUsd: 0,
        durationMs: 10,
      } as const;
    }) as RunSubagent;
    const tool = makeTool(runSubagent);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "parallel",
      {
        profile: "explorer",
        tasks: [
          { label: "first", task: "first" },
          { label: "second", task: "second" },
        ],
        budget: { maxTurns: 2 },
      },
      undefined,
      (update) => updates.push(update),
    );

    expect(maxActive).toBe(2);
    const finalNodes = (
      updates.at(-1) as {
        details: { progress: { nodes: { label: string; status: string }[] } };
      }
    ).details.progress.nodes;
    expect(finalNodes.map((node) => [node.label, node.status])).toEqual([
      ["first", "completed"],
      ["second", "completed"],
    ]);
    expect(result.content).toEqual([{ type: "text", text: "[1] first\n\n[2] second" }]);
    expect(result.details).toMatchObject({
      mode: "parallel",
      results: [{ runId: "first" }, { runId: "second" }],
    });
  });

  test("caps a tasks batch at four concurrent subagents", async () => {
    let active = 0;
    let maxActive = 0;
    const runSubagent = (async (request: SubagentRunRequest) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {
        runId: request.task,
        status: "completed",
        output: request.task,
        text: request.task,
        model: { provider: "test", id: "model" },
        turns: 1,
        toolCalls: 0,
        toolCallCounts: {},
        usage: testUsage(1),
        tokens: 1,
        costUsd: 0,
        durationMs: 10,
      } as const;
    }) as RunSubagent;
    const tool = makeTool(runSubagent);

    const result = await tool.execute("parallel-cap", {
      profile: "explorer",
      tasks: Array.from({ length: 6 }, (_, index) => ({ task: `job ${index + 1}` })),
    });

    expect(maxActive).toBe(4);
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("[6] job 6");
  });

  test("returns a completed subagent result to the main agent", async () => {
    const runSubagent = vi.fn(completedRun("focused answer"));
    const tool = makeTool(runSubagent);

    const result = await tool.execute("call-1", {
      profile: "explorer",
      task: "Investigate one question",
      budget: { maxTurns: 2 },
    });

    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Investigate one question",
        profile: "explorer",
        budget: { maxTurns: 2 },
      }),
    );
    // The tool grant is the profile's to make, so nothing reaches the runner.
    expect(runSubagent.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(result.content).toEqual([{ type: "text", text: "focused answer" }]);
    expect(result.details).toMatchObject({ status: "completed", runId: "subagent-1" });
  });

  test("formats structured subagent output as JSON", async () => {
    const tool = makeTool(completedRun({ quality: "low_content", stuck: false }));

    const result = await tool.execute("call-2", {
      profile: "explorer",
      task: "Classify",
      outputSchema: { type: "object" },
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: '{\n  "quality": "low_content",\n  "stuck": false\n}',
    });
  });

  test("reports budget exhaustion and its concrete reason to the main agent", async () => {
    const runSubagent = (async () => ({
      runId: "subagent-budget",
      status: "budget_exceeded",
      model: { provider: "test", id: "model" },
      turns: 100,
      toolCalls: 0,
      toolCallCounts: {},
      usage: testUsage(1_000, 1.25),
      tokens: 1_000,
      costUsd: 1.25,
      durationMs: 1_000,
      error: "LLM calls 100 >= 100 limit",
    })) as RunSubagent;
    const tool = makeTool(runSubagent);

    const result = await tool.execute("call-budget", { profile: "explorer", task: "Keep working" });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Subagent stopped: budget limit exceeded (LLM calls 100 >= 100 limit)",
      },
    ]);
    expect(result.details).toMatchObject({ status: "budget_exceeded" });
  });

  test("forwards cancellation and reports incomplete status", async () => {
    const controller = new AbortController();
    const runSubagent = (async (request: SubagentRunRequest) => {
      expect(request.signal).toBe(controller.signal);
      return {
        runId: "subagent-2",
        status: "cancelled",
        model: { provider: "test", id: "model" },
        turns: 0,
        toolCalls: 0,
        toolCallCounts: {},
        usage: testUsage(0),
        tokens: 0,
        costUsd: 0,
        durationMs: 1,
      } as const;
    }) as RunSubagent;
    const tool = makeTool(runSubagent);

    const result = await tool.execute(
      "call-3",
      { profile: "explorer", task: "Cancel me" },
      controller.signal,
    );

    expect(result.content).toEqual([{ type: "text", text: "Subagent cancelled" }]);
    expect(result.details).toMatchObject({ status: "cancelled" });
  });
});
