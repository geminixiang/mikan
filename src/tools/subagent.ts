import type { AgentTool, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { SubagentRunOutput, SubagentRunRequest, SubagentRunResult } from "../harness/types.js";
// Progress statuses extend run statuses with the pre- and non-run states. The
// dashboard renders the same union, so it is defined once alongside the
// snapshot the tool emits rather than restated here.
import type {
  SubagentProgressNode,
  SubagentProgressSnapshot,
  SubagentProgressStatus,
} from "../types.js";
import { recordSubagentOutcome, reportSubagentLaunchError } from "../observability/sentry.js";

const MAX_DAG_NODES = 8;
const MAX_DAG_EDGES = 16;
const MAX_DAG_DEPTH = 4;
const MAX_CONCURRENT_SUBAGENTS = 4;
const MAX_DEPENDENCY_OUTPUT_CHARS = 4000;

/**
 * Every subagent runs under a named profile: the profile owns the prompt,
 * tool grant, model and budget defaults. Letting the model assemble those
 * per call proved unstable, so the schema deliberately exposes no
 * `systemPrompt`, `tools` or `model` escape hatch — narrowing what the model
 * can get wrong is the point. `budget` survives so the model can propose
 * limits. Token requests may raise the profile allowance; the other fields can
 * only tighten profile defaults.
 *
 * `profileNames` is baked into the schema as an enum to steer the model's
 * choice. TypeBox does not check `enum` on a string, so an unknown name still
 * reaches `validatePlanProfiles`, which names the available profiles.
 */
function buildTaskProperties(profileNames: string[]) {
  return {
    task: Type.String({ minLength: 1, description: "Self-contained task for a fresh subagent." }),
    profile: Type.Optional(
      Type.String({
        enum: profileNames,
        description:
          "Profile this subagent runs under. Required, but a top-level profile covers every task and DAG node that does not set its own.",
      }),
    ),
    // No length bound: a label is a display string, and `taskLabel` clamps it.
    // Bounding it in the schema only lets a cosmetic field reject a whole DAG,
    // and validation reports that failure by echoing every node back.
    label: Type.Optional(Type.String({ description: "Short progress label for this subagent." })),
    input: Type.Optional(
      Type.Unknown({ description: "Optional JSON-serializable structured input for the task." }),
    ),
  };
}

const sharedProperties = {
  parentContext: Type.Optional(
    Type.Object({
      mode: Type.Literal("normalized"),
      recentTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 3 })),
    }),
  ),
  outputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Optional TypeBox/JSON Schema applied to every subagent result.",
    }),
  ),
  budget: Type.Optional(
    Type.Object(
      {
        maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
        maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
        maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
      },
      {
        description:
          "Sets run budget preferences. maxTokens may raise the profile allowance; other fields can only tighten profile defaults.",
      },
    ),
  ),
};

/**
 * The runtime schema varies only in the `profile` enum, so every instance
 * shares one static type and `subagentSchema` below can stand in for it.
 */
function buildSubagentSchema(profileNames: string[]) {
  const taskProperties = buildTaskProperties(profileNames);
  return Type.Object(
    {
      task: Type.Optional(taskProperties.task),
      profile: taskProperties.profile,
      label: taskProperties.label,
      input: taskProperties.input,
      tasks: Type.Optional(
        Type.Array(Type.Object(taskProperties), {
          minItems: 1,
          maxItems: MAX_DAG_NODES,
          description:
            "Independent subagent tasks executed concurrently; results preserve input order.",
        }),
      ),
      dag: Type.Optional(
        Type.Object({
          nodes: Type.Array(
            Type.Object({
              id: Type.String({
                pattern: "^[A-Za-z0-9_-]+$",
                maxLength: 64,
                description: "Unique stable node id used by dependsOn.",
              }),
              ...taskProperties,
              dependsOn: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_DAG_NODES })),
            }),
            { minItems: 1, maxItems: MAX_DAG_NODES },
          ),
          maxConcurrency: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: MAX_CONCURRENT_SUBAGENTS,
              default: MAX_CONCURRENT_SUBAGENTS,
            }),
          ),
        }),
      ),
      ...sharedProperties,
    },
    { description: "Provide task, tasks, or dag." },
  );
}

const subagentSchema = buildSubagentSchema([]);

type SubagentParams = Static<typeof subagentSchema>;
type SubagentTask = NonNullable<SubagentParams["tasks"]>[number];
type DagNode = NonNullable<SubagentParams["dag"]>["nodes"][number];
type SharedParams = Pick<SubagentParams, "parentContext" | "outputSchema" | "budget">;
/**
 * `hooks` carries host-side callbacks rather than widening the request: the
 * request is the public shape the model asks for, and a
 * progress sink belongs to whoever is displaying the run.
 */
type RunSubagent = <TOutputSchema extends TSchema | undefined = undefined>(
  request: SubagentRunRequest<TOutputSchema>,
  hooks?: { onActivity?: (activity: string) => void },
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

/** The metrics half of a progress node — derived, not restated. */
type SubagentProgressMetrics = Omit<SubagentProgressNode, "id" | "label" | "status" | "profile">;

/** Shortest gap between activity-driven redraws of the dashboard. */
const ACTIVITY_EMIT_INTERVAL_MS = 2000;

class SubagentProgressTracker {
  private lastActivityEmit = 0;
  private readonly states = new Map<string, SubagentProgressStatus>();
  private readonly metrics = new Map<string, SubagentProgressMetrics>();

  constructor(
    private readonly mode: PlanMode,
    private readonly items: Array<{ id: string; label: string; profile?: string }>,
    private readonly onUpdate?: AgentToolUpdateCallback,
  ) {
    for (const item of items) this.states.set(item.id, "pending");
  }

  update(id: string, status: SubagentProgressStatus, metrics?: SubagentProgressMetrics): void {
    this.states.set(id, status);
    if (metrics) this.metrics.set(id, metrics);
    this.emit();
  }

  /**
   * Record what a node is doing, rate-limited.
   *
   * Status changes are rare and each one matters, so `update` emits every
   * time. Activity is the opposite — it can change several times a second
   * while text streams — and every emission redraws the whole response, on a
   * path that is deliberately not batched. Left unbounded this would spend the
   * platform's edit budget on a character counter.
   */
  activity(id: string, activity: string): void {
    const previous = this.metrics.get(id) ?? {};
    this.metrics.set(id, { ...previous, activity });
    const now = Date.now();
    if (now - this.lastActivityEmit < ACTIVITY_EMIT_INTERVAL_MS) return;
    this.lastActivityEmit = now;
    this.emit();
  }

  emit(): void {
    if (!this.onUpdate) return;
    const nodes = this.items.map((item) =>
      boundSubagentProgressNode({
        ...item,
        status: this.states.get(item.id) ?? ("pending" as SubagentProgressStatus),
        ...this.metrics.get(item.id),
      }),
    );
    this.onUpdate({
      content: [],
      details: { progress: { mode: this.mode, nodes } },
    });
  }
}

function taskLabel(task: SubagentTask, fallback: string): string {
  return clampSubagentLabel(task.label?.trim() || task.task.trim().slice(0, 48) || fallback);
}

function formatOutcome(outcome: {
  status: SubagentProgressStatus;
  output?: unknown;
  error?: string;
}): string {
  if (outcome.status === "budget_exceeded") {
    return `Subagent stopped: budget limit exceeded${outcome.error ? ` (${outcome.error})` : ""}`;
  }
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
    ...(task.profile ? { profile: task.profile } : {}),
    ...(task.input !== undefined ? { input: task.input } : {}),
    ...(shared.parentContext ? { parentContext: shared.parentContext } : {}),
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

/**
 * A top-level `profile` is the default for every task and DAG node, like the
 * other shared params. A fan-out that runs entirely under one profile then
 * names it once instead of repeating it per node.
 */
function withDefaultProfile<T extends { profile?: string }>(task: T, fallback?: string): T {
  return task.profile || !fallback ? task : { ...task, profile: fallback };
}

function itemForNode(node: DagNode, defaultProfile?: string): PlanItem {
  return {
    id: node.id,
    label: clampSubagentLabel(node.label?.trim() || node.id),
    task: withDefaultProfile(node, defaultProfile),
    dependsOn: node.dependsOn ?? [],
  };
}

/** Normalize every tool mode into one plan: nodes, waves, concurrency. */
function buildPlan(params: SubagentParams): Plan {
  const modeCount = [params.task, params.tasks, params.dag].filter(
    (mode) => mode !== undefined,
  ).length;
  if (modeCount !== 1) {
    throw new Error("Subagent requires exactly one of task, tasks, or dag");
  }

  if (params.dag !== undefined) {
    const toItem = (node: DagNode) => itemForNode(node, params.profile);
    const waves = buildDagWaves(params.dag.nodes).map((wave) => wave.map(toItem));
    const requested = params.dag.maxConcurrency ?? MAX_CONCURRENT_SUBAGENTS;
    return {
      mode: "dag",
      items: params.dag.nodes.map(toItem),
      waves,
      concurrency: Math.max(1, Math.min(MAX_CONCURRENT_SUBAGENTS, Math.floor(requested))),
    };
  }
  if (params.tasks !== undefined) {
    const items = params.tasks.map((task, index) => ({
      id: String(index),
      label: taskLabel(task, String(index + 1)),
      task: withDefaultProfile(task, params.profile),
      dependsOn: [],
    }));
    return { mode: "parallel", items, waves: [items], concurrency: MAX_CONCURRENT_SUBAGENTS };
  }
  if (!params.task) throw new Error("Subagent requires task, tasks, or dag");
  const task = { ...params, task: params.task };
  const item = { id: "0", label: taskLabel(task, "subagent"), task, dependsOn: [] };
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
        const item = items[index];
        if (item === undefined) continue;
        await worker(item, index);
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
 * One executor for every mode: wave barriers and a per-invocation concurrency
 * bound. Process-wide slots are acquired by the shared runner seam.
 */
async function runWaves(
  plan: Plan,
  shared: SharedParams,
  runSubagent: RunSubagent,
  progress: SubagentProgressTracker,
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
        recordSubagentOutcome({
          itemId: item.id,
          mode: plan.mode,
          status: "skipped",
          profile: item.task.profile,
          error: `Dependency ${failedDependency} did not complete`,
        });
        progress.update(item.id, "skipped", {
          reason: `Dependency ${failedDependency} did not complete`,
        });
        return;
      }
      let result: SubagentRunResult<unknown>;
      progress.update(item.id, "running");
      try {
        result = await runSubagent(planRequest(item, shared, outcomes, signal), {
          onActivity: (activity: string) => progress.activity(item.id, activity),
        });
      } catch (error) {
        reportSubagentLaunchError(error, {
          itemId: item.id,
          mode: plan.mode,
          profile: item.task.profile,
        });
        throw error;
      }
      outcomes.set(item.id, { id: item.id, ...result });
      recordSubagentOutcome({
        itemId: item.id,
        mode: plan.mode,
        status: result.status,
        profile: item.task.profile,
        error: result.error,
        turns: result.turns,
        toolCalls: result.toolCalls,
        tokens: result.tokens,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        cleanupPending: result.cleanupPending,
      });
      progress.update(item.id, result.status, {
        turns: result.turns,
        toolCalls: result.toolCalls,
        toolCallCounts: result.toolCallCounts,
        tokens: result.tokens,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
        ...(result.error ? { reason: result.error } : {}),
        ...(result.cleanupPending ? { cleanupPending: true } : {}),
      });
    });
  }
  return plan.items.map((item) => outcomes.get(item.id)!);
}

/** What the model needs to choose a profile: what it is, and what it can do. */
interface SubagentProfileMenuEntry {
  description: string;
  tools?: string[];
}

/**
 * The tool grant belongs in the menu. A description alone reads as a stylistic
 * constraint, so a model will pick a no-tool profile for work that needs tools
 * and then narrate the tool call it could not make.
 */
function formatToolGrant(tools: string[] | undefined): string {
  if (!tools) return "tools unknown";
  return tools.length === 0 ? "no tools" : `tools: ${tools.join(", ")}`;
}

function validatePlanProfiles(plan: Plan, availableProfiles: ReadonlySet<string>): void {
  const known = [...availableProfiles].join(", ");
  for (const item of plan.items) {
    const profile = item.task.profile;
    if (!profile) {
      throw new Error(`Subagent ${item.label} must specify a profile (available: ${known})`);
    }
    if (!availableProfiles.has(profile)) {
      throw new Error(`Unknown subagent profile: ${profile} (available: ${known})`);
    }
  }
}

/**
 * Create the normal agent's bounded subagent delegation and DAG tool.
 * `globalSlots` is the process-wide fan-out account shared across every
 * conversation's tool instance; omitted, fan-out is bounded per run only.
 *
 * `profiles` must be non-empty: it is both the model-facing menu and the only
 * way to grant a subagent any capability at all.
 */
export function createSubagentTool(
  runSubagent: RunSubagent,
  profiles: ReadonlyMap<string, SubagentProfileMenuEntry>,
): AgentTool<typeof subagentSchema> {
  if (profiles.size === 0) {
    throw new Error("createSubagentTool requires at least one subagent profile");
  }
  const profileDescription = [...profiles.entries()]
    .map(
      ([name, profile]) => `${name} [${formatToolGrant(profile.tools)}] — ${profile.description}`,
    )
    .join("; ");
  return {
    name: "subagent",
    label: "Subagent",
    description:
      `Run fresh isolated subagents. Use task for one subagent, tasks for independent concurrent work, or dag.nodes for a bounded dependency graph. At most ${MAX_CONCURRENT_SUBAGENTS} subagents run concurrently. DAG limits: ${MAX_DAG_NODES} nodes, ${MAX_DAG_EDGES} edges, depth ${MAX_DAG_DEPTH}; failed dependencies skip descendants, and dependency outputs larger than ${MAX_DEPENDENCY_OUTPUT_CHARS} characters reach downstream nodes as a truncated string. ` +
      "Subagents are fresh by default; parentContext.mode=normalized can include a sanitized reference snapshot of the active parent run. Nested subagents are not allowed. " +
      `Every task and DAG node must set profile; the profile supplies the prompt, tools, model and budget. Available profiles: ${profileDescription}.`,
    parameters: buildSubagentSchema([...profiles.keys()]),
    execute: async (
      _toolCallId: string,
      params: SubagentParams,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const plan = buildPlan(params);
      validatePlanProfiles(plan, new Set(profiles.keys()));
      const progress = new SubagentProgressTracker(
        plan.mode,
        plan.items.map(({ id, label, task }) => ({ id, label, profile: task.profile })),
        onUpdate,
      );
      progress.emit();
      const ordered = await runWaves(plan, params, runSubagent, progress, signal);

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
          const single = ordered[0];
          if (single === undefined) {
            throw new Error("Subagent plan produced no outcome");
          }
          const { id: _id, ...result } = single;
          return {
            content: [{ type: "text", text: formatOutcome(result) }],
            details: result,
          };
        }
      }
    },
  };
}

// Subagent progress protocol: the tool owns construction, transport validation,
// settlement and its canonical response-source dashboard. Presenters consume it.

/** Longest label the dashboard renders; longer ones are clamped, never rejected. */
export const MAX_SUBAGENT_LABEL_CHARS = 100;
const MAX_PROFILE_CHARS = 64;
const MAX_REASON_CHARS = 240;
const MAX_ACTIVITY_CHARS = 80;

const SUBAGENT_STATUS_MARKER = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  cancelled: "■",
  timeout: "◷",
  budget_exceeded: "!",
  invalid_output: "✗",
  skipped: "⊘",
} satisfies Record<SubagentProgressStatus, string>;

const SUBAGENT_STATUS_LABEL = {
  pending: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timeout: "Timed out",
  budget_exceeded: "Budget exceeded",
  invalid_output: "Invalid output",
  skipped: "Skipped",
} satisfies Record<SubagentProgressStatus, string>;

/**
 * Derived from the marker table, which `satisfies` keeps exhaustive: a new
 * terminal status is a compile error there, and this runtime set follows —
 * the validator can never silently drop a status the tables know about.
 */
const VALID_STATUSES: ReadonlySet<string> = new Set(Object.keys(SUBAGENT_STATUS_MARKER));

/** Clamp a label to the display bound, ending a truncation visibly with `…`. */
function clampSubagentLabel(label: string): string {
  if (label.length <= MAX_SUBAGENT_LABEL_CHARS) return label;
  return `${label.slice(0, MAX_SUBAGENT_LABEL_CHARS - 1)}…`;
}

/** The display bounds, applied once at construction and again on parse. */
export function boundSubagentProgressNode(node: SubagentProgressNode): SubagentProgressNode {
  return {
    ...node,
    label: clampSubagentLabel(node.label),
    ...(node.profile !== undefined ? { profile: node.profile.slice(0, MAX_PROFILE_CHARS) } : {}),
    ...(node.activity !== undefined
      ? { activity: node.activity.slice(0, MAX_ACTIVITY_CHARS) }
      : {}),
    ...(node.reason !== undefined ? { reason: node.reason.slice(0, MAX_REASON_CHARS) } : {}),
  };
}

function parseNode(value: unknown): SubagentProgressNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<keyof SubagentProgressNode, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.label !== "string" ||
    typeof item.status !== "string" ||
    !VALID_STATUSES.has(item.status)
  ) {
    return undefined;
  }
  return boundSubagentProgressNode({
    id: item.id,
    label: item.label,
    status: item.status as SubagentProgressStatus,
    ...(typeof item.profile === "string" ? { profile: item.profile } : {}),
    ...(typeof item.turns === "number" ? { turns: item.turns } : {}),
    ...(typeof item.toolCalls === "number" ? { toolCalls: item.toolCalls } : {}),
    ...(item.toolCallCounts && typeof item.toolCallCounts === "object"
      ? {
          toolCallCounts: Object.fromEntries(
            Object.entries(item.toolCallCounts).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
          ),
        }
      : {}),
    ...(typeof item.tokens === "number" ? { tokens: item.tokens } : {}),
    ...(typeof item.costUsd === "number" ? { costUsd: item.costUsd } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(typeof item.activity === "string" ? { activity: item.activity } : {}),
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    ...(item.cleanupPending === true ? { cleanupPending: true } : {}),
  });
}

/**
 * Parse a snapshot back off the untyped transport. All-or-nothing: one
 * malformed node means the payload is not ours (any tool can put anything in
 * `details`), so the whole candidate is rejected rather than partially shown.
 */
export function parseSubagentProgressSnapshot(
  value: unknown,
): SubagentProgressSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { mode?: unknown; nodes?: unknown };
  if (
    (candidate.mode !== "single" && candidate.mode !== "parallel" && candidate.mode !== "dag") ||
    !Array.isArray(candidate.nodes)
  ) {
    return undefined;
  }
  const nodes: SubagentProgressNode[] = [];
  for (const node of candidate.nodes) {
    const parsed = parseNode(node);
    if (!parsed) return undefined;
    nodes.push(parsed);
  }
  return { mode: candidate.mode, nodes };
}

/**
 * Project a live snapshot to its end-of-tool state: nodes still pending or
 * running settle to the tool call's outcome. Metrics spread through
 * unchanged — an unsettled node never reported any.
 */
export function settleSubagentProgress(
  snapshot: SubagentProgressSnapshot,
  isError: boolean,
): SubagentProgressSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.status !== "running" && node.status !== "pending"
        ? node
        : { ...node, status: isError ? "failed" : "completed" },
    ),
  };
}

/**
 * Fold concurrent or successive subagent fan-outs into the single snapshot the
 * dashboard renders. A run can call the subagent tool more than once; picking
 * one snapshot would drop the others' cost and status, and alternating between
 * them makes the live view flicker. Node ids are namespaced by source because
 * each fan-out numbers its own nodes from zero.
 */
export function mergeSubagentProgress(
  snapshots: readonly SubagentProgressSnapshot[],
): SubagentProgressSnapshot | undefined {
  if (snapshots.length === 0) return undefined;
  if (snapshots.length === 1) return snapshots[0];
  const nodes = snapshots.flatMap((snapshot, index) =>
    snapshot.nodes.map((node) => ({ ...node, id: `${index}:${node.id}` })),
  );
  const mode = snapshots.some((snapshot) => snapshot.mode === "dag")
    ? "dag"
    : nodes.length > 1
      ? "parallel"
      : "single";
  return { mode, nodes };
}

// ---------------------------------------------------------------------------
// Dashboard text
// ---------------------------------------------------------------------------

function settledCount(snapshot: SubagentProgressSnapshot): number {
  return snapshot.nodes.filter((node) => node.status !== "pending" && node.status !== "running")
    .length;
}

function modeLabel(snapshot: SubagentProgressSnapshot): string {
  if (snapshot.mode === "dag") return "DAG";
  if (snapshot.mode === "parallel") return "Parallel";
  return "Run";
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()<>#+\-.!|~])/g, "\\$1");
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function summaryText(snapshot: SubagentProgressSnapshot): string {
  const totals = snapshot.nodes.reduce(
    (sum, node) => ({
      turns: sum.turns + (node.turns ?? 0),
      toolCalls: sum.toolCalls + (node.toolCalls ?? 0),
      tokens: sum.tokens + (node.tokens ?? 0),
      costUsd: sum.costUsd + (node.costUsd ?? 0),
    }),
    { turns: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  );
  return [
    totals.turns > 0 ? `${totals.turns} LLM turns` : undefined,
    totals.toolCalls > 0 ? `${totals.toolCalls} tool calls` : undefined,
    totals.tokens > 0 ? `${compactNumber(totals.tokens)} tokens` : undefined,
    totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The dashboard's one-line summary header, unformatted. */
function dashboardHeader(snapshot: SubagentProgressSnapshot): string {
  const base = `Subagents · ${settledCount(snapshot)}/${snapshot.nodes.length} · ${modeLabel(snapshot)}`;
  const summary = summaryText(snapshot);
  return summary ? `${base} · ${summary}` : base;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function detailText(node: SubagentProgressNode): string {
  const toolBreakdown = node.toolCallCounts
    ? Object.entries(node.toolCallCounts)
        .map(([name, count]) => `${name} ×${count}`)
        .join(" · ")
    : undefined;
  const metrics = [
    node.turns !== undefined ? countLabel(node.turns, "LLM turn") : undefined,
    node.toolCalls !== undefined ? countLabel(node.toolCalls, "tool call") : undefined,
    toolBreakdown,
    node.tokens !== undefined ? `${compactNumber(node.tokens)} tokens` : undefined,
    node.costUsd !== undefined ? `$${node.costUsd.toFixed(4)}` : undefined,
    node.durationMs !== undefined ? `${(node.durationMs / 1000).toFixed(1)}s` : undefined,
  ].filter(Boolean);
  const reason = node.cleanupPending ? "Cleanup pending; usage is provisional" : node.reason;
  // Activity is shown only while running, and that is exactly when there is
  // nothing else: a node reports its metrics on the way out, so without this
  // the whole of a long step reads "Running · profile" and never changes.
  const activity = node.status === "running" ? node.activity : undefined;
  // Profile leads the line: when a node reports no tool calls, the profile is
  // what says whether that was the plan or a bad pick.
  return [SUBAGENT_STATUS_LABEL[node.status], node.profile, activity, ...metrics, reason]
    .filter(Boolean)
    .join(" · ");
}

/** The dashboard as response source Markdown; adapters own any conversion. */
export function renderSubagentDashboard(snapshot: SubagentProgressSnapshot): string {
  const header = `**${dashboardHeader(snapshot)}**`;
  const rows = snapshot.nodes.flatMap((node) => [
    `${SUBAGENT_STATUS_MARKER[node.status]} ${escapeMarkdown(node.label)}`,
    `└ ${detailText(node)}`,
  ]);
  return [header, ...rows].join("\n");
}
