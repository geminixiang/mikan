import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentAuditRun } from "../audit/index.js";
import { contentText, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Kind, Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as log from "../log.js";
import type { MikanModels } from "./models.js";
import type { SubagentProfile } from "./types.js";
import { MikanAgentSession } from "./runner.js";
import { SessionStore } from "./session-store.js";
import type {
  SubagentModelSpec,
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentUsage,
  SubagentUsageSink,
} from "./types.js";
import { copyUsage, createEmptyUsage } from "./usage.js";
import { unboundedSlotPool, type SubagentSlotPool } from "./subagent-slots.js";

const subagentRunDepth = new AsyncLocalStorage<number>();
const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete only the assigned task and return the result directly.";
export const DEFAULT_SUBAGENT_BUDGET = {
  maxTurns: 100,
  maxCostUsd: 10,
  maxDurationMs: 10 * 60 * 1000,
} as const;

/** Time allowed for an aborted subagent to settle before detached cleanup. */
export const SUBAGENT_ABORT_GRACE_MS = 100;

const SCHEMA_STRUCTURAL_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaOptions(node: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!SCHEMA_STRUCTURAL_KEYS.has(key)) options[key] = value;
  }
  if (isRecord(options.additionalProperties)) {
    options.additionalProperties = hydrateSchema(options.additionalProperties);
  }
  return options;
}

/**
 * outputSchema arrives over the subagent tool as plain JSON (tool-call
 * arguments never carry TypeBox's Kind symbol), but Value.Check dispatches
 * purely on schema[Kind] and throws ValueCheckUnknownTypeError for anything
 * without it. Hydrate plain JSON Schema into real TypeBox schema nodes so
 * validation runs instead of throwing; schemas built with TypeBox already
 * carry Kind and pass through untouched.
 *
 * Unsupported keywords ($ref, not, patternProperties, if/then/else) degrade to
 * a permissive Unknown — fail-open by design: outputSchema is advisory output
 * validation, not a security boundary.
 */
function hydrateSchema(schema: unknown): TSchema {
  if (isRecord(schema) && Kind in schema) return schema as TSchema;
  if (!isRecord(schema)) return Type.Unknown();

  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.filter(
      (value): value is string | number | boolean =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    );
    return literals.length > 0
      ? Type.Union(literals.map((value) => Type.Literal(value)))
      : Type.Unknown();
  }
  if ("const" in schema) {
    const value = schema.const;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? Type.Literal(value)
      : Type.Unknown();
  }
  if (Array.isArray(schema.anyOf)) return Type.Union(schema.anyOf.map(hydrateSchema));
  if (Array.isArray(schema.oneOf)) return Type.Union(schema.oneOf.map(hydrateSchema));
  if (Array.isArray(schema.allOf)) return Type.Intersect(schema.allOf.map(hydrateSchema));

  const type = Array.isArray(schema.type)
    ? schema.type
    : (schema.type ?? (schema.properties ? "object" : schema.items ? "array" : undefined));
  if (Array.isArray(type)) {
    return Type.Union(type.map((variant) => hydrateSchema({ ...schema, type: variant })));
  }

  const options = schemaOptions(schema);
  switch (type) {
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const props: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(properties)) {
        const hydrated = hydrateSchema(value);
        props[key] = required.has(key) ? hydrated : Type.Optional(hydrated);
      }
      return Type.Object(props, options);
    }
    case "array":
      return Type.Array(
        schema.items !== undefined ? hydrateSchema(schema.items) : Type.Unknown(),
        options,
      );
    case "string":
      return Type.String(options);
    case "number":
      return Type.Number(options);
    case "integer":
      return Type.Integer(options);
    case "boolean":
      return Type.Boolean(options);
    case "null":
      return Type.Null(options);
    default:
      return Type.Unknown(options);
  }
}

interface SubagentAuditContext {
  runId: string;
  run?: AgentAuditRun;
  parent?: AgentAuditRun;
  parentToolCallId?: string;
  terminalRecorded: boolean;
}

interface RunSubagentOptions<TOutputSchema extends TSchema | undefined = undefined> {
  request: SubagentRunRequest<TOutputSchema>;
  defaultModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  models: MikanModels;
  workspaceDir: string;
  availableTools: AgentTool[];
  profiles?: ReadonlyMap<string, SubagentProfile>;
  /** Process-wide launch pool shared by tool and extension invocations. */
  slots?: SubagentSlotPool;
  /** Host-snapshotted parent transcript; never sourced from the public request. */
  parentMessages?: AgentMessage[];
  /** Usage attribution sink snapshotted when this invocation begins. */
  onUsage?: SubagentUsageSink;
  /** Active parent-run identity for child-run correlation. */
  auditIdentity?: {
    parentRun: AgentAuditRun;
    parentToolCallId?: string;
  };
  /** Created internally by `runSubagent`; callers supply only `auditIdentity`. */
  auditContext?: SubagentAuditContext;
  /**
   * Called as the run's visible activity changes, so a caller can show what
   * this subagent is doing rather than only that it started. Best-effort: a
   * throwing sink is logged and the run continues.
   */
  onActivity?: (activity: string) => void;
}

/**
 * Translate a subagent session's event stream into short activity lines.
 *
 * The stream was always there — nothing subscribed to it, so every subagent
 * was silent for its whole run and a slow step looked identical to a hung one.
 *
 * Text is reported as a growing character count rather than its content: it
 * proves liveness during a long single-turn generation, which is the case with
 * nothing else to show, without putting a half-written answer on screen.
 */
function reportSubagentActivity(
  session: MikanAgentSession,
  onActivity: (activity: string) => void,
): void {
  let characters = 0;
  let reportedAt = 0;
  const report = (activity: string): void => {
    try {
      onActivity(activity);
    } catch (err) {
      log.logWarning("Subagent onActivity listener failed", String(err));
    }
  };

  session.subscribe(async (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as { label?: string };
      const name = String(event.toolName ?? "tool");
      report(args.label ? `${name}: ${args.label}` : name);
      return;
    }
    if (event.type === "tool_execution_end") {
      report("thinking");
      return;
    }
    if (event.type === "message_start") {
      characters = 0;
      reportedAt = 0;
      report("thinking");
      return;
    }
    if (event.type === "message_update") {
      const delta = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
        .assistantMessageEvent;
      if (delta?.type !== "text_delta" || !delta.delta) return;
      characters += delta.delta.length;
      // Coarse steps: deltas arrive per token, and one report each would churn
      // the dashboard for no added information.
      if (characters - reportedAt < ACTIVITY_CHARS_STEP) return;
      reportedAt = characters;
      report(`writing · ${characters} chars`);
      return;
    }
    if (event.type === "auto_retry_start") {
      // The most valuable line here: a retry is the usual reason a run goes
      // quiet for minutes, and it was completely invisible.
      report("retrying after an error");
    }
  });
}

/** How much new text earns a fresh activity line during a long generation. */
const ACTIVITY_CHARS_STEP = 250;

function resolveBudget(budget: RunSubagentOptions["request"]["budget"]) {
  const resolved = { ...DEFAULT_SUBAGENT_BUDGET, ...budget };
  const positiveIntegerFields = [
    ["maxTurns", resolved.maxTurns],
    ["maxTokens", resolved.maxTokens],
    ["maxDurationMs", resolved.maxDurationMs],
  ] as const;
  for (const [name, value] of positiveIntegerFields) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`api.subagent.run budget.${name} must be a positive integer`);
    }
  }
  if (!Number.isFinite(resolved.maxCostUsd) || resolved.maxCostUsd < 0) {
    throw new Error("api.subagent.run budget.maxCostUsd must be a non-negative number");
  }
  return resolved;
}

function selectTools(requested: string[] | undefined, available: AgentTool[]): AgentTool[] {
  if (!requested || requested.length === 0) return [];
  const byName = new Map<string, AgentTool>();
  for (const tool of available) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
  }
  const selected: AgentTool[] = [];
  for (const name of new Set(requested)) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown or unavailable subagent tool: ${name}`);
    selected.push(tool);
  }
  return selected;
}

/**
 * Wrap a tool so the run can prove it was actually reached. Fields are listed
 * explicitly rather than spread: `AgentTool` is a plain interface, and a
 * structural copy would silently drop anything added to it later.
 */
function witnessToolUse(tool: AgentTool, invoked: Set<string>): AgentTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.constrainedSampling !== undefined
      ? { constrainedSampling: tool.constrainedSampling }
      : {}),
    ...(tool.prepareArguments ? { prepareArguments: tool.prepareArguments.bind(tool) } : {}),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    execute: (...args: Parameters<AgentTool["execute"]>) => {
      invoked.add(tool.name);
      return tool.execute(...args);
    },
  };
}

function formatTask(task: string, input: unknown, parentContext?: string): string {
  const trimmed = task.trim();
  if (!trimmed) throw new Error("api.subagent.run requires a non-empty task");
  let formatted = trimmed;
  if (input !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(input, null, 2);
    } catch (err) {
      throw new Error(
        `api.subagent.run input must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (serialized === undefined)
      throw new Error("api.subagent.run input must be JSON-serializable");
    formatted = `${trimmed}\n\nInput:\n${serialized}`;
  }
  return parentContext ? `${parentContext}\n\n${formatted}` : formatted;
}

function messageText(message: AgentMessage): string {
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return message.summary;
  }
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function normalizedParentContext(
  request: SubagentRunRequest<TSchema | undefined>,
  messages: AgentMessage[] | undefined,
): string | undefined {
  if (!request.parentContext || !messages) return undefined;
  const recentTurns = request.parentContext.recentTurns ?? 3;
  if (!Number.isInteger(recentTurns) || recentTurns < 1 || recentTurns > 8) {
    throw new Error("api.subagent.run parentContext.recentTurns must be an integer from 1 to 8");
  }
  const conversation = messages.filter(
    (message) => (message.role === "user" || message.role === "assistant") && messageText(message),
  );
  let first = conversation.length;
  let users = 0;
  while (first > 0 && users < recentTurns) {
    first -= 1;
    if (conversation[first]?.role === "user") users += 1;
  }
  const recent = conversation.slice(first);
  const recentStart = recent[0] ? messages.indexOf(recent[0]) : messages.length;
  let summary: AgentMessage | undefined;
  for (let index = recentStart - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "compactionSummary" || message?.role === "branchSummary") {
      summary = message;
      break;
    }
  }
  return [
    "<parent_reference_context>",
    summary ? `Earlier summary: ${messageText(summary)}` : "[Earlier parent context omitted]",
    ...recent.map(
      (message) => `${message.role === "user" ? "User" : "Assistant"}: ${messageText(message)}`,
    ),
    "</parent_reference_context>",
  ].join("\n");
}

/**
 * The evidence policy has to name the actual grant. Told to "use granted
 * tools" while holding none, a model will write a tool call as prose and
 * hand that text back as its answer — which then flows to dependent DAG
 * nodes as if it were a finding.
 */
function groundingPolicy(toolNames: string[]): string {
  if (toolNames.length === 0) {
    return [
      "Evidence policy:",
      "- You have NO tools in this run. Do not emit tool calls or tool-call syntax; they will not execute.",
      "- Answer only from the task text and any structured input supplied to you.",
      "- Never claim to have read a file, run a command, or reached a repository or URL.",
      "- If the task cannot be done without a tool, say so plainly and stop.",
    ].join("\n");
  }
  return [
    "Evidence policy:",
    `- Your tools this run: ${toolNames.join(", ")}. Nothing else will execute.`,
    "- Use them for any claim about files, commands, repositories, or external state.",
    "- Never simulate tool output or claim a tool was used when it was not.",
    "- If the task requires a tool you were not granted, state that you cannot verify it instead of guessing.",
  ].join("\n");
}

function buildSystemPrompt(
  base: string | undefined,
  outputSchema: TSchema | undefined,
  toolNames: string[],
): string {
  const prompt = [base?.trim() || DEFAULT_SYSTEM_PROMPT, groundingPolicy(toolNames)].join("\n\n");
  if (!outputSchema) return prompt;
  return [
    prompt,
    "",
    "Return only one JSON value matching this JSON Schema. Do not use Markdown or code fences.",
    JSON.stringify(outputSchema),
  ].join("\n");
}

type SubagentRunStats = ReturnType<MikanAgentSession["getLastRunStats"]>;

/**
 * Every SubagentRunResult's metric fields are born here — one derivation from
 * the session's run stats, so adding a metric is one edit and no terminal
 * site can drift (the abort branch once shipped without toolCallCounts). The
 * terminal sites state only what differs: status, error, text.
 */
function baseRunResult(
  runId: string,
  model: SubagentModelSpec,
  startedAt: number,
  stats?: SubagentRunStats,
) {
  const usage = stats?.usage ?? createEmptyUsage();
  return {
    runId,
    model,
    turns: stats?.llmCalls ?? 0,
    toolCalls: stats?.toolCalls ?? 0,
    toolCallCounts: stats?.toolCallCounts ?? {},
    usage,
    tokens: usage.totalTokens,
    costUsd: usage.cost.total,
    durationMs: Date.now() - startedAt,
  };
}

function finalAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function assistantText(message: AssistantMessage | undefined): string {
  return message ? contentText(message.content, "") : "";
}

function beginSubagentAudit<TOutputSchema extends TSchema | undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): SubagentAuditContext {
  const runId = randomUUID();
  const parent = options.auditIdentity?.parentRun;
  const parentToolCallId = options.auditIdentity?.parentToolCallId;
  try {
    const run = parent?.child({ runKind: "subagent", runId, parentToolCallId });
    run?.record({ type: "run_admitted", status: "admitted" });
    parent?.record({
      type: "subagent_spawned",
      status: "running",
      relatedRunId: runId,
      toolCallId: parentToolCallId,
    });
    return { runId, run, parent, parentToolCallId, terminalRecorded: false };
  } catch (error) {
    log.logWarning("Subagent audit admission failed", String(error));
    return { runId, terminalRecorded: false };
  }
}

function finishSubagentAudit(
  context: SubagentAuditContext,
  result: SubagentRunResult<unknown>,
): void {
  if (context.terminalRecorded) return;
  context.terminalRecorded = true;
  const failed = result.status === "failed" || result.status === "invalid_output";
  const aborted =
    result.status === "cancelled" ||
    result.status === "timeout" ||
    result.status === "budget_exceeded";
  try {
    context.run?.record({
      type: aborted ? "run_aborted" : failed ? "run_failed" : "run_completed",
      status: result.status,
      durationMs: result.durationMs,
      llmCalls: result.turns,
      toolCalls: result.toolCalls,
      usage: {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        totalTokens: result.tokens,
        costUsd: result.costUsd,
      },
      ...(failed ? { errorType: "subagent_failure" } : {}),
    });
    context.parent?.record({
      type: "subagent_completed",
      status: result.status,
      relatedRunId: context.runId,
      toolCallId: context.parentToolCallId,
      durationMs: result.durationMs,
    });
  } catch (error) {
    log.logWarning("Subagent audit settlement failed", String(error));
  }
}

/**
 * Execute one non-recursive, fresh subagent run. Never rejects: every
 * failure — including request validation — is a result with a terminal
 * status, so batch callers (`tasks` / `dag`) can never orphan in-flight
 * sibling runs on one bad request. Usage is reported once, after the
 * underlying run settles; an aborted run may report it from detached cleanup.
 */
export async function runSubagent<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  const auditContext = beginSubagentAudit(options);
  const execution = await executeBoundedSubagentRun({ ...options, auditContext });
  if (execution.cleanup) {
    void execution.cleanup
      .then(async (result) => {
        finishSubagentAudit(auditContext, result);
        await reportSubagentUsage(options.onUsage, result.usage);
      })
      .catch((err) => {
        log.logWarning("Subagent detached cleanup failed", String(err));
      });
    return execution.result;
  }
  finishSubagentAudit(auditContext, execution.result);
  await reportSubagentUsage(options.onUsage, execution.result.usage);
  return execution.result;
}

async function reportSubagentUsage(
  onUsage: SubagentUsageSink | undefined,
  usage: SubagentUsage,
): Promise<void> {
  try {
    await onUsage?.(copyUsage(usage));
  } catch (err) {
    log.logWarning("Subagent onUsage listener failed", String(err));
  }
}

type BoundedSubagentExecution<TOutput> = {
  result: SubagentRunResult<TOutput>;
  /** Resolves after an aborted prompt settles and returns its final result. */
  cleanup?: Promise<SubagentRunResult<TOutput>>;
};

async function executeBoundedSubagentRun<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<BoundedSubagentExecution<SubagentRunOutput<TOutputSchema>>> {
  const auditContext = options.auditContext;
  if (!auditContext) throw new Error("Subagent audit context was not initialized");
  const startedAt = Date.now();
  let release: (() => void) | undefined;
  try {
    release = await (options.slots ?? unboundedSlotPool()).acquire(options.request.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const model = options.request.model ?? {
        provider: options.defaultModel.provider,
        id: options.defaultModel.id,
      };
      return {
        result: { ...baseRunResult(auditContext.runId, model, startedAt), status: "cancelled" },
      };
    }
    throw err;
  }
  if (!release) throw new Error("Subagent slot acquisition returned no release handle");

  try {
    const execution = await executeSubagentRun(options);
    if (!execution.cleanup) {
      release();
      release = undefined;
      return execution;
    }

    const cleanup = execution.cleanup;
    const heldRelease = release;
    void cleanup
      .then(
        () => heldRelease(),
        (err) => {
          log.logWarning("Subagent detached cleanup failed", String(err));
          heldRelease();
        },
      )
      .catch((err) => {
        log.logWarning("Subagent detached release failed", String(err));
        heldRelease();
      });
    release = undefined;
    return execution;
  } catch (err) {
    release?.();
    release = undefined;
    throw err;
  }
}

function noop(): void {}

/**
 * Expand `request.profile` into the concrete capability set it names. Most
 * profile budgets are caps that callers may only tighten. Token budgets are
 * different: the effective allowance is the larger of the profile default and
 * the caller's request.
 */
function resolveProfile<TOutputSchema extends TSchema | undefined>(
  request: SubagentRunRequest<TOutputSchema>,
  options: RunSubagentOptions<TOutputSchema>,
): SubagentRunRequest<TOutputSchema> {
  if (!request.profile) return request;
  const profile = options.profiles?.get(request.profile);
  if (!profile) {
    const known = [...(options.profiles?.keys() ?? [])].join(", ");
    throw new Error(
      `Unknown subagent profile: ${request.profile}${known ? ` (available: ${known})` : ""}`,
    );
  }
  if (request.tools || request.model || request.systemPrompt || request.thinkingLevel) {
    throw new Error(
      `Subagent profile ${request.profile} cannot be combined with tools, model, systemPrompt, or thinkingLevel`,
    );
  }
  const budget = {
    ...request.budget,
    ...(profile.maxTurns !== undefined
      ? { maxTurns: Math.min(profile.maxTurns, request.budget?.maxTurns ?? profile.maxTurns) }
      : {}),
    ...(profile.maxTokens !== undefined || request.budget?.maxTokens !== undefined
      ? { maxTokens: Math.max(profile.maxTokens ?? 0, request.budget?.maxTokens ?? 0) }
      : {}),
    ...(profile.maxCostUsd !== undefined
      ? {
          maxCostUsd: Math.min(
            profile.maxCostUsd,
            request.budget?.maxCostUsd ?? profile.maxCostUsd,
          ),
        }
      : {}),
    ...(profile.maxDurationMs !== undefined
      ? {
          maxDurationMs: Math.min(
            profile.maxDurationMs,
            request.budget?.maxDurationMs ?? profile.maxDurationMs,
          ),
        }
      : {}),
  };
  return {
    ...request,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    requiredTools: profile.requiredTools,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  };
}

async function executeSubagentRun<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<BoundedSubagentExecution<SubagentRunOutput<TOutputSchema>>> {
  const auditContext = options.auditContext;
  if (!auditContext) throw new Error("Subagent audit context was not initialized");
  let request = options.request;
  const { runId, run: auditRun } = auditContext;
  const startedAt = Date.now();
  let modelSpec: SubagentModelSpec = request.model ?? {
    provider: options.defaultModel.provider,
    id: options.defaultModel.id,
  };
  let sessionRef: MikanAgentSession | undefined;
  let terminalSignal: "cancelled" | "timeout" | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let notifyAbort: () => void = noop;
  const abortRequested = new Promise<void>((resolve) => {
    notifyAbort = resolve;
  });
  const abort = (reason: "cancelled" | "timeout") => {
    if (terminalSignal) return;
    terminalSignal = reason;
    sessionRef?.abort();
    notifyAbort();
  };
  const onAbort = () => abort("cancelled");

  try {
    request = resolveProfile(options.request, options);
    if ((subagentRunDepth.getStore() ?? 0) >= 1) {
      throw new Error("Nested api.subagent.run calls are not allowed");
    }
    const model = request.model
      ? options.models.resolve(request.model.provider, request.model.id)
      : options.defaultModel;
    modelSpec = { provider: model.provider, id: model.id };
    const invokedTools = new Set<string>();
    const granted = selectTools(request.tools, options.availableTools);
    const missingRequiredTools = (request.requiredTools ?? []).filter(
      (name) => !granted.some((tool) => tool.name === name),
    );
    if (missingRequiredTools.length > 0) {
      throw new Error(
        `Required subagent tools were not granted: ${missingRequiredTools.join(", ")}`,
      );
    }
    const tools = granted.map((tool) => witnessToolUse(tool, invokedTools));
    const task = formatTask(
      request.task,
      request.input,
      normalizedParentContext(request, options.parentMessages),
    );
    const budget = resolveBudget(request.budget);
    const session = new MikanAgentSession({
      systemPrompt: buildSystemPrompt(
        request.systemPrompt,
        request.outputSchema,
        granted.map((tool) => tool.name),
      ),
      model,
      thinkingLevel: request.thinkingLevel ?? options.thinkingLevel,
      tools,
      models: options.models,
      sessionStore: SessionStore.inMemory(options.workspaceDir),
      settings: { compaction: { enabled: false } },
    });
    sessionRef = session;
    auditRun?.record({
      type: "run_started",
      status: "running",
      modelProvider: model.provider,
      modelId: model.id,
    });
    if (options.onActivity) reportSubagentActivity(session, options.onActivity);

    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) abort("cancelled");
    timeout = setTimeout(() => abort("timeout"), budget.maxDurationMs);
    timeout.unref();

    const buildResult = (
      cleanupPending = false,
    ): SubagentRunResult<SubagentRunOutput<TOutputSchema>> => {
      const stats = session.getLastRunStats();
      const assistant = finalAssistant(session.messages);
      const text = assistantText(assistant);
      const base = {
        ...baseRunResult(runId, modelSpec, startedAt, stats),
        ...(text ? { text } : {}),
        ...(cleanupPending ? { cleanupPending: true as const } : {}),
      };

      if (terminalSignal) {
        return {
          ...base,
          status: terminalSignal,
          ...(terminalSignal === "timeout"
            ? { error: `Subagent exceeded its ${budget.maxDurationMs}ms duration limit` }
            : {}),
        };
      }
      if (stats.budgetExceededReason) {
        return {
          ...base,
          status: "budget_exceeded",
          error: stats.budgetExceededReason,
        };
      }
      const unusedRequiredTools = (request.requiredTools ?? []).filter(
        (name) => !invokedTools.has(name),
      );
      if (unusedRequiredTools.length > 0) {
        return {
          ...base,
          status: "failed",
          error: `Required tool not used: ${unusedRequiredTools.join(", ")}`,
        };
      }
      if (assistant?.stopReason === "error") {
        return {
          ...base,
          status: "failed",
          error: assistant.errorMessage || "Subagent failed",
        };
      }
      if (!assistant) {
        return { ...base, status: "failed", error: "Subagent produced no assistant response" };
      }

      if (request.outputSchema) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ...base, status: "invalid_output", error: "Subagent output is not valid JSON" };
        }
        if (!Value.Check(hydrateSchema(request.outputSchema), parsed)) {
          return {
            ...base,
            status: "invalid_output",
            error: "Subagent output does not match the requested schema",
          };
        }
        return {
          ...base,
          status: "completed",
          output: parsed as SubagentRunOutput<TOutputSchema>,
        };
      }

      if (!text) {
        return { ...base, status: "failed", error: "Subagent produced no text output" };
      }
      return {
        ...base,
        status: "completed",
        output: text as SubagentRunOutput<TOutputSchema>,
      };
    };
    const buildFailureResult = (
      err: unknown,
    ): SubagentRunResult<SubagentRunOutput<TOutputSchema>> => ({
      ...baseRunResult(runId, modelSpec, startedAt, session.getLastRunStats()),
      status: terminalSignal ?? "failed",
      error: err instanceof Error ? err.message : String(err),
    });

    if (!terminalSignal) {
      const promptOutcome = subagentRunDepth
        .run(1, () =>
          session.prompt(task, {
            budget: {
              maxLlmCalls: budget.maxTurns,
              maxTokens: budget.maxTokens,
              maxCostUsd: budget.maxCostUsd,
              // maxDurationMs deliberately not passed down: the hard-deadline
              // timer above owns wall-clock enforcement (it can also abort a
              // stalled provider call, which a per-message budget check
              // cannot). Passing it to both made the terminal status a race
              // between "timeout" and "budget_exceeded".
            },
            auditRun,
          }),
        )
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      const winner = await Promise.race([
        promptOutcome.then((outcome) => ({ type: "settled" as const, outcome })),
        abortRequested.then(async () => {
          let graceTimer: NodeJS.Timeout | undefined;
          const graceExpired = new Promise<"expired">((resolve) => {
            graceTimer = setTimeout(() => resolve("expired"), SUBAGENT_ABORT_GRACE_MS);
          });
          const graceOutcome = await Promise.race([
            promptOutcome.then((settledOutcome) => ({
              type: "settled" as const,
              outcome: settledOutcome,
            })),
            graceExpired.then((value) => ({ type: value as "expired" })),
          ]);
          if (graceTimer) clearTimeout(graceTimer);
          return graceOutcome;
        }),
      ]);
      if (winner.type === "expired") {
        const provisional = buildResult(true);
        const cleanup = promptOutcome.then((settledOutcome) =>
          settledOutcome.ok ? buildResult() : buildFailureResult(settledOutcome.error),
        );
        return { result: provisional, cleanup };
      }
      if (!winner.outcome.ok) throw winner.outcome.error;
    }

    return { result: buildResult() };
  } catch (err) {
    return {
      result: {
        ...baseRunResult(runId, modelSpec, startedAt, sessionRef?.getLastRunStats()),
        status: terminalSignal ?? "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
