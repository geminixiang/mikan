import type { TSchema } from "@sinclair/typebox";
import { describe, expect, test, vi } from "vitest";
import type {
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
} from "../src/harness/types.js";
import { createSubagentTool } from "../src/tools/subagent.js";

type RunSubagent = <TOutputSchema extends TSchema | undefined = undefined>(
  request: SubagentRunRequest<TOutputSchema>,
) => Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>>;

function completedRun(output: unknown): RunSubagent {
  return (async () => ({
    runId: "subagent-1",
    status: "completed",
    output,
    text: typeof output === "string" ? output : JSON.stringify(output),
    model: { provider: "test", id: "model" },
    turns: 1,
    tokens: 10,
    costUsd: 0,
    durationMs: 5,
  })) as RunSubagent;
}

describe("subagent tool", () => {
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
        tokens: 1,
        costUsd: 0,
        durationMs: 10,
      } as const;
    }) as RunSubagent;
    const tool = createSubagentTool(runSubagent);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "dag",
      {
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
    const finalProgress = (updates.at(-1) as { details: { progressLabel: string } }).details
      .progressLabel;
    expect(finalProgress).toContain("Subagent DAG 3/3");
    expect(finalProgress).toContain("✓ a");
    expect(finalProgress).toContain("✓ combine");
    expect(result.content).toEqual([{ type: "text", text: "[a] A\n\n[b] B\n\n[combine] AB" }]);
    expect(result.details).toMatchObject({
      mode: "dag",
      waves: [["a", "b"], ["combine"]],
    });
  });

  test("rejects cyclic DAGs before starting subagents", async () => {
    const runSubagent = vi.fn(completedRun("unused"));
    const tool = createSubagentTool(runSubagent);

    await expect(
      tool.execute("cycle", {
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
    const tool = createSubagentTool(runSubagent);

    await expect(
      tool.execute("deep", {
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
        tokens: 1,
        costUsd: 0,
        durationMs: 1,
      } as const;
    }) as RunSubagent;
    const tool = createSubagentTool(runSubagent);

    const result = await tool.execute("failure", {
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
        tokens: 1,
        costUsd: 0,
        durationMs: 10,
      } as const;
    }) as RunSubagent;
    const tool = createSubagentTool(runSubagent);
    const updates: unknown[] = [];

    const result = await tool.execute(
      "parallel",
      {
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
    const progressLabels = updates.map(
      (update) => (update as { details: { progressLabel: string } }).details.progressLabel,
    );
    expect(progressLabels.at(-1)).toContain("Subagent parallel 2/2");
    expect(progressLabels.at(-1)).toContain("✓ first");
    expect(progressLabels.at(-1)).toContain("✓ second");
    expect(result.content).toEqual([{ type: "text", text: "[1] first\n\n[2] second" }]);
    expect(result.details).toMatchObject({
      mode: "parallel",
      results: [{ runId: "first" }, { runId: "second" }],
    });
  });

  test("returns a completed subagent result to the main agent", async () => {
    const runSubagent = vi.fn(completedRun("focused answer"));
    const tool = createSubagentTool(runSubagent);

    const result = await tool.execute("call-1", {
      task: "Investigate one question",
      tools: ["read"],
      budget: { maxTurns: 2 },
    });

    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "Investigate one question",
        tools: ["read"],
        budget: { maxTurns: 2 },
      }),
    );
    expect(result.content).toEqual([{ type: "text", text: "focused answer" }]);
    expect(result.details).toMatchObject({ status: "completed", runId: "subagent-1" });
  });

  test("formats structured subagent output as JSON", async () => {
    const tool = createSubagentTool(completedRun({ quality: "low_content", stuck: false }));

    const result = await tool.execute("call-2", {
      task: "Classify",
      outputSchema: { type: "object" },
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: '{\n  "quality": "low_content",\n  "stuck": false\n}',
    });
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
        tokens: 0,
        costUsd: 0,
        durationMs: 1,
      } as const;
    }) as RunSubagent;
    const tool = createSubagentTool(runSubagent);

    const result = await tool.execute("call-3", { task: "Cancel me" }, controller.signal);

    expect(result.content).toEqual([{ type: "text", text: "Subagent cancelled" }]);
    expect(result.details).toMatchObject({ status: "cancelled" });
  });
});
