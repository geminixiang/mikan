import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type {
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentRunStatus,
} from "../harness/types.js";
import { unboundedSlotPool, type SubagentSlotPool } from "./subagent-slots.js";

const MAX_DAG_NODES = 8;
const MAX_DAG_EDGES = 16;
const MAX_DAG_DEPTH = 4;
const MAX_CONCURRENT_SUBAGENTS = 4;
const MAX_DEPENDENCY_OUTPUT_CHARS = 4000;

const taskProperties = {
  task: Type.String({ minLength: 1, description: "Self-contained task for a fresh subagent." }),
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
        Type.Integer({
          minimum: 1,
          maximum: MAX_CONCURRENT_SUBAGENTS,
          default: MAX_CONCURRENT_SUBAGENTS,
        }),
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

type PlanMode = "single" | "parallel" | "dag";

/** One planned subagent run; single and tasks modes are plans with no edges. */
interface PlanItem {
  id: string;
  label: string;
  task: SubagentTask;
  dependsOn: string[];
}

interface Plan {
  mode: PlanMode;
  items: PlanItem[];
  waves: PlanItem[][];
  concurrency: number;
}

type PlanOutcome =
  | ({ id: string } & SubagentRunResult<unknown>)
  | { id: string; status: "skipped"; error: string };

/**
 * Progress statuses extend run statuses with the pre- and non-run states, so
 * a new run status is surfaced verbatim (and the marker map below fails to
 * compile until it covers it) instead of silently collapsing.
 */
type SubagentProgressStatus = SubagentRunStatus | "pending" | "running" | "skipped";

const STATUS_MARKER = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  cancelled: "✗",
  timeout: "✗",
  budget_exceeded: "✗",
  invalid_output: "✗",
  skipped: "⊘",
} satisfies Record<SubagentProgressStatus, string>;

class SubagentProgressTracker {
  private readonly states = new Map<string, SubagentProgressStatus>();

  constructor(
    private readonly mode: PlanMode,
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
      status: this.states.get(item.id) ?? ("pending" as SubagentProgressStatus),
    }));
    const settled = nodes.filter(
      (node) => node.status !== "pending" && node.status !== "running",
    ).length;
    const modeLabel = this.mode === "dag" ? "DAG" : this.mode === "parallel" ? "parallel" : "run";
    const progressLabel = [
      `Subagent ${modeLabel} ${settled}/${nodes.length}`,
      ...nodes.map((node) => `${STATUS_MARKER[node.status]} ${node.label}`),
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

function formatOutcome(outcome: {
  status: SubagentProgressStatus;
  output?: unknown;
  error?: string;
}): string {
  if (outcome.status !== "completed") {
    return `Subagent ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`;
  }
  return typeof outcome.output === "string"
    ? outcome.output
    : JSON.stringify(outcome.output, null, 2);
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

function itemForNode(node: DagNode): PlanItem {
  return {
    id: node.id,
    label: node.label?.trim() || node.id,
    task: node,
    dependsOn: node.dependsOn ?? [],
  };
}

/** Normalize every tool mode into one plan: nodes, waves, concurrency. */
function buildPlan(params: SubagentParams): Plan {
  if ("dag" in params) {
    const waves = buildDagWaves(params.dag.nodes).map((wave) => wave.map(itemForNode));
    const requested = params.dag.maxConcurrency ?? MAX_CONCURRENT_SUBAGENTS;
    return {
      mode: "dag",
      items: params.dag.nodes.map(itemForNode),
      waves,
      concurrency: Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS, Math.floor(requested))),
    };
  }
  if ("tasks" in params) {
    const items = params.tasks.map((task, index) => ({
      id: String(index),
      label: taskLabel(task, String(index + 1)),
      task,
      dependsOn: [],
    }));
    return { mode: "parallel", items, waves: [items], concurrency: MAX_CONCURRENT_SUBAGENTS };
  }
  const item = { id: "0", label: taskLabel(params, "subagent"), task: params, dependsOn: [] };
  return { mode: "single", items: [item], waves: [[item]], concurrency: 1 };
}

/** Run `worker` over every item with at most `limit` in flight. */
async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index], index);
      }
    }),
  );
}

function dependencyOutput(outcome: PlanOutcome): unknown {
  if (outcome.status !== "completed") return undefined;
  const value = outcome.output;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) return null;
  if (serialized.length <= MAX_DEPENDENCY_OUTPUT_CHARS) return value;
  // Oversized structured output becomes a marked string — the shape is lost,
  // which the tool description warns downstream consumers about.
  return `${serialized.slice(0, MAX_DEPENDENCY_OUTPUT_CHARS)}\n[truncated]`;
}

function planRequest(
  item: PlanItem,
  shared: SharedParams,
  outcomes: Map<string, PlanOutcome>,
  signal?: AbortSignal,
): SubagentRunRequest<TSchema | undefined> {
  if (item.dependsOn.length === 0) return buildRequest(item.task, shared, signal);
  const dependencies = Object.fromEntries(
    item.dependsOn.map((id) => [id, dependencyOutput(outcomes.get(id)!)]),
  );
  const input = {
    ...(item.task.input !== undefined ? { input: item.task.input } : {}),
    dependencies,
  };
  return buildRequest({ ...item.task, input }, shared, signal);
}

/**
 * One executor for every mode: wave barriers, a bounded slot pool inside
 * each wave, and one global slot per actual subagent launch — the seam where
 * both the per-run cap and the process-wide ceiling are enforced.
 */
async function runWaves(
  plan: Plan,
  shared: SharedParams,
  runSubagent: RunSubagent,
  progress: SubagentProgressTracker,
  globalSlots: SubagentSlotPool,
  signal?: AbortSignal,
): Promise<PlanOutcome[]> {
  const outcomes = new Map<string, PlanOutcome>();
  for (const wave of plan.waves) {
    await forEachConcurrent(wave, plan.concurrency, async (item) => {
      const failedDependency = item.dependsOn.find(
        (id) => outcomes.get(id)?.status !== "completed",
      );
      if (failedDependency) {
        outcomes.set(item.id, {
          id: item.id,
          status: "skipped",
          error: `Dependency ${failedDependency} did not complete`,
        });
        progress.update(item.id, "skipped");
        return;
      }
      const release = await globalSlots.acquire();
      let result: SubagentRunResult<unknown>;
      try {
        progress.update(item.id, "running");
        result = await runSubagent(planRequest(item, shared, outcomes, signal));
      } finally {
        release();
      }
      outcomes.set(item.id, { id: item.id, ...result });
      progress.update(item.id, result.status);
    });
  }
  return plan.items.map((item) => outcomes.get(item.id)!);
}

/**
 * Create the normal agent's bounded subagent delegation and DAG tool.
 * `globalSlots` is the process-wide fan-out account shared across every
 * conversation's tool instance; omitted, fan-out is bounded per run only.
 */
export function createSubagentTool(
  runSubagent: RunSubagent,
  globalSlots: SubagentSlotPool = unboundedSlotPool(),
): AgentTool<typeof subagentSchema> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      `Run fresh isolated subagents. Use task for one subagent, tasks for independent concurrent work, or dag.nodes for a bounded dependency graph. At most ${MAX_CONCURRENT_SUBAGENTS} subagents run concurrently. DAG limits: ${MAX_DAG_NODES} nodes, ${MAX_DAG_EDGES} edges, depth ${MAX_DAG_DEPTH}; failed dependencies skip descendants, and dependency outputs larger than ${MAX_DEPENDENCY_OUTPUT_CHARS} characters reach downstream nodes as a truncated string. ` +
      "Subagents have no history or tools unless explicitly provided; nested subagents are not allowed.",
    parameters: subagentSchema,
    execute: async (
      _toolCallId: string,
      params: SubagentParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const plan = buildPlan(params);
      const progress = new SubagentProgressTracker(
        plan.mode,
        plan.items.map(({ id, label }) => ({ id, label })),
        onUpdate,
      );
      progress.emit();
      const ordered = await runWaves(plan, params, runSubagent, progress, globalSlots, signal);

      switch (plan.mode) {
        case "dag":
          return {
            content: [
              {
                type: "text",
                text: ordered
                  .map((outcome) => `[${outcome.id}] ${formatOutcome(outcome)}`)
                  .join("\n\n"),
              },
            ],
            details: {
              mode: "dag",
              waves: plan.waves.map((wave) => wave.map((item) => item.id)),
              results: ordered,
            },
          };
        case "parallel": {
          const results = ordered.map(({ id: _id, ...result }) => result);
          return {
            content: [
              {
                type: "text",
                text: results
                  .map((result, index) => `[${index + 1}] ${formatOutcome(result)}`)
                  .join("\n\n"),
              },
            ],
            details: { mode: "parallel", results },
          };
        }
        case "single": {
          const { id: _id, ...result } = ordered[0];
          return {
            content: [{ type: "text", text: formatOutcome(result) }],
            details: result,
          };
        }
      }
    },
  };
}
