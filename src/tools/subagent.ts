import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { SubagentRunOutput, SubagentRunRequest, SubagentRunResult } from "../harness/types.js";

const MAX_DAG_NODES = 8;
const MAX_DAG_EDGES = 16;
const MAX_DAG_DEPTH = 4;
const MAX_DAG_CONCURRENCY = 4;
const MAX_DEPENDENCY_OUTPUT_CHARS = 4000;

const taskProperties = {
  task: Type.String({ description: "Self-contained task for a fresh subagent." }),
  label: Type.Optional(
    Type.String({ maxLength: 64, description: "Short progress label for this subagent." }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Optional role or behavior instructions for the subagent." }),
  ),
  input: Type.Optional(
    Type.Unknown({ description: "Optional JSON-serializable structured input for the task." }),
  ),
};

const sharedProperties = {
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool names explicitly granted to each subagent. Defaults to no tools.",
    }),
  ),
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Optional TypeBox/JSON Schema applied to every subagent result.",
    }),
  ),
  budget: Type.Optional(
    Type.Object({
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
      maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
      maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
};

const subagentTaskSchema = Type.Object(taskProperties);
const dagNodeSchema = Type.Object({
  id: Type.String({
    pattern: "^[A-Za-z0-9_-]+$",
    maxLength: 64,
    description: "Unique stable node id used by dependsOn.",
  }),
  ...taskProperties,
  dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_DAG_NODES })),
});
const subagentSchema = Type.Union([
  Type.Object({ ...taskProperties, ...sharedProperties }),
  Type.Object({
    tasks: Type.Array(subagentTaskSchema, {
      minItems: 1,
      maxItems: MAX_DAG_NODES,
      description:
        "Independent subagent tasks executed concurrently; results preserve input order.",
    }),
    ...sharedProperties,
  }),
  Type.Object({
    dag: Type.Object({
      nodes: Type.Array(dagNodeSchema, { minItems: 1, maxItems: MAX_DAG_NODES }),
      maxConcurrency: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_DAG_CONCURRENCY, default: MAX_DAG_CONCURRENCY }),
      ),
    }),
    ...sharedProperties,
  }),
]);

type SubagentParams = Static<typeof subagentSchema>;
type SubagentTask = Static<typeof subagentTaskSchema>;
type DagNode = Static<typeof dagNodeSchema>;
type SharedParams = Pick<SubagentParams, "model" | "tools" | "outputSchema" | "budget">;
type RunSubagent = <TOutputSchema extends TSchema | undefined = undefined>(
  request: SubagentRunRequest<TOutputSchema>,
) => Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>>;
type DagNodeOutcome =
  | ({ id: string } & SubagentRunResult<unknown>)
  | { id: string; status: "skipped"; error: string };
type SubagentProgressStatus = "pending" | "running" | "completed" | "failed" | "skipped";

class SubagentProgressTracker {
  private readonly states = new Map<string, SubagentProgressStatus>();

  constructor(
    private readonly mode: "single" | "parallel" | "dag",
    private readonly items: Array<{ id: string; label: string }>,
    private readonly onUpdate?: AgentToolUpdateCallback,
  ) {
    for (const item of items) this.states.set(item.id, "pending");
  }

  update(id: string, status: SubagentProgressStatus): void {
    this.states.set(id, status);
    this.emit();
  }

  emit(): void {
    if (!this.onUpdate) return;
    const nodes = this.items.map((item) => ({
      ...item,
      status: this.states.get(item.id) ?? "pending",
    }));
    const settled = nodes.filter((node) =>
      ["completed", "failed", "skipped"].includes(node.status),
    ).length;
    const marker = {
      pending: "○",
      running: "●",
      completed: "✓",
      failed: "✗",
      skipped: "⊘",
    } satisfies Record<SubagentProgressStatus, string>;
    const modeLabel = this.mode === "dag" ? "DAG" : this.mode === "parallel" ? "parallel" : "run";
    const progressLabel = [
      `Subagent ${modeLabel} ${settled}/${nodes.length}`,
      ...nodes.map((node) => `${marker[node.status]} ${node.label}`),
    ].join(" · ");
    this.onUpdate({
      content: [],
      details: { progressLabel, progress: { mode: this.mode, nodes } },
    });
  }
}

function taskLabel(task: SubagentTask, fallback: string): string {
  return task.label?.trim() || task.task.trim().slice(0, 48) || fallback;
}

function resultProgressStatus(result: SubagentRunResult<unknown>): SubagentProgressStatus {
  return result.status === "completed" ? "completed" : "failed";
}

function formatResult(result: SubagentRunResult<unknown>): string {
  if (result.status !== "completed") {
    return `Subagent ${result.status}${result.error ? `: ${result.error}` : ""}`;
  }
  return typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
}

function buildRequest(
  task: SubagentTask,
  shared: SharedParams,
  signal?: AbortSignal,
): SubagentRunRequest<TSchema | undefined> {
  const outputSchema = shared.outputSchema as TSchema | undefined;
  return {
    task: task.task,
    ...(task.systemPrompt ? { systemPrompt: task.systemPrompt } : {}),
    ...(task.input !== undefined ? { input: task.input } : {}),
    ...(shared.model ? { model: shared.model } : {}),
    ...(shared.tools ? { tools: shared.tools } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(shared.budget ? { budget: shared.budget } : {}),
    ...(signal ? { signal } : {}),
  };
}

function buildDagWaves(nodes: DagNode[]): DagNode[][] {
  if (nodes.length === 0 || nodes.length > MAX_DAG_NODES) {
    throw new Error(`Subagent DAG must contain 1-${MAX_DAG_NODES} nodes`);
  }
  const byId = new Map<string, DagNode>();
  let edgeCount = 0;
  for (const node of nodes) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(node.id)) {
      throw new Error(`Invalid subagent DAG node id: ${node.id}`);
    }
    if (byId.has(node.id)) throw new Error(`Duplicate subagent DAG node id: ${node.id}`);
    byId.set(node.id, node);
    const dependencies = new Set(node.dependsOn ?? []);
    if (dependencies.size !== (node.dependsOn?.length ?? 0)) {
      throw new Error(`Duplicate dependency on subagent DAG node: ${node.id}`);
    }
    edgeCount += dependencies.size;
  }
  if (edgeCount > MAX_DAG_EDGES) {
    throw new Error(`Subagent DAG exceeds ${MAX_DAG_EDGES} dependency edges`);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(`Unknown subagent DAG dependency ${dependency} for node ${node.id}`);
      }
      if (dependency === node.id) throw new Error(`Subagent DAG node ${node.id} depends on itself`);
    }
  }

  const remaining = new Set(nodes.map((node) => node.id));
  const completed = new Set<string>();
  const waves: DagNode[][] = [];
  while (remaining.size > 0) {
    const wave = nodes.filter(
      (node) => remaining.has(node.id) && (node.dependsOn ?? []).every((id) => completed.has(id)),
    );
    if (wave.length === 0) throw new Error("Subagent DAG contains a cycle");
    waves.push(wave);
    if (waves.length > MAX_DAG_DEPTH) {
      throw new Error(`Subagent DAG exceeds maximum depth ${MAX_DAG_DEPTH}`);
    }
    for (const node of wave) {
      remaining.delete(node.id);
      completed.add(node.id);
    }
  }
  return waves;
}

function dependencyOutput(outcome: DagNodeOutcome): unknown {
  if (outcome.status !== "completed") return undefined;
  const value = outcome.output;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) return null;
  if (serialized.length <= MAX_DEPENDENCY_OUTPUT_CHARS) return value;
  return `${serialized.slice(0, MAX_DEPENDENCY_OUTPUT_CHARS)}\n[truncated]`;
}

function dagRequest(
  node: DagNode,
  shared: SharedParams,
  outcomes: Map<string, DagNodeOutcome>,
  signal?: AbortSignal,
): SubagentRunRequest<TSchema | undefined> {
  const dependencies = Object.fromEntries(
    (node.dependsOn ?? []).map((id) => [id, dependencyOutput(outcomes.get(id)!)]),
  );
  const input =
    node.dependsOn && node.dependsOn.length > 0
      ? { ...(node.input !== undefined ? { input: node.input } : {}), dependencies }
      : node.input;
  return buildRequest({ ...node, ...(input !== undefined ? { input } : {}) }, shared, signal);
}

async function runDag(
  nodes: DagNode[],
  maxConcurrency: number,
  shared: SharedParams,
  runSubagent: RunSubagent,
  progress: SubagentProgressTracker,
  signal?: AbortSignal,
): Promise<{ waves: string[][]; results: DagNodeOutcome[] }> {
  const waves = buildDagWaves(nodes);
  const concurrency = Math.max(1, Math.min(MAX_DAG_CONCURRENCY, Math.floor(maxConcurrency)));
  const outcomes = new Map<string, DagNodeOutcome>();
  for (const wave of waves) {
    for (let offset = 0; offset < wave.length; offset += concurrency) {
      const chunk = wave.slice(offset, offset + concurrency);
      for (const node of chunk) progress.update(node.id, "running");
      await Promise.all(
        chunk.map(async (node) => {
          const failedDependency = (node.dependsOn ?? []).find(
            (id) => outcomes.get(id)?.status !== "completed",
          );
          if (failedDependency) {
            outcomes.set(node.id, {
              id: node.id,
              status: "skipped",
              error: `Dependency ${failedDependency} did not complete`,
            });
            progress.update(node.id, "skipped");
            return;
          }
          const result = await runSubagent(dagRequest(node, shared, outcomes, signal));
          outcomes.set(node.id, { id: node.id, ...result });
          progress.update(node.id, resultProgressStatus(result));
        }),
      );
    }
  }
  return {
    waves: waves.map((wave) => wave.map((node) => node.id)),
    results: nodes.map((node) => outcomes.get(node.id)!),
  };
}

function formatDagOutcome(outcome: DagNodeOutcome): string {
  if (outcome.status === "skipped") return `Subagent skipped: ${outcome.error}`;
  return formatResult(outcome);
}

/** Create the normal agent's bounded subagent delegation and DAG tool. */
export function createSubagentTool(runSubagent: RunSubagent): AgentTool<typeof subagentSchema> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Run fresh isolated subagents. Use task for one subagent, tasks for independent concurrent work, or dag.nodes for a bounded dependency graph. DAG limits: 8 nodes, 16 edges, depth 4, concurrency 4; failed dependencies skip descendants. Subagents have no history or tools unless explicitly provided; nested subagents are not allowed.",
    parameters: subagentSchema,
    execute: async (
      _toolCallId: string,
      params: SubagentParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      if ("dag" in params) {
        const progress = new SubagentProgressTracker(
          "dag",
          params.dag.nodes.map((node) => ({
            id: node.id,
            label: node.label?.trim() || node.id,
          })),
          onUpdate,
        );
        progress.emit();
        const result = await runDag(
          params.dag.nodes,
          params.dag.maxConcurrency ?? MAX_DAG_CONCURRENCY,
          params,
          runSubagent,
          progress,
          signal,
        );
        return {
          content: [
            {
              type: "text",
              text: result.results
                .map((outcome) => `[${outcome.id}] ${formatDagOutcome(outcome)}`)
                .join("\n\n"),
            },
          ],
          details: { mode: "dag", ...result },
        };
      }
      if ("tasks" in params) {
        const progress = new SubagentProgressTracker(
          "parallel",
          params.tasks.map((task, index) => ({
            id: String(index),
            label: taskLabel(task, String(index + 1)),
          })),
          onUpdate,
        );
        progress.emit();
        const results = await Promise.all(
          params.tasks.map(async (task, index) => {
            const id = String(index);
            progress.update(id, "running");
            const result = await runSubagent(buildRequest(task, params, signal));
            progress.update(id, resultProgressStatus(result));
            return result;
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: results
                .map((result, index) => `[${index + 1}] ${formatResult(result)}`)
                .join("\n\n"),
            },
          ],
          details: { mode: "parallel", results },
        };
      }

      const progress = new SubagentProgressTracker(
        "single",
        [{ id: "0", label: taskLabel(params, "subagent") }],
        onUpdate,
      );
      progress.update("0", "running");
      const result = await runSubagent(buildRequest(params, params, signal));
      progress.update("0", resultProgressStatus(result));
      return {
        content: [{ type: "text", text: formatResult(result) }],
        details: result,
      };
    },
  };
}
