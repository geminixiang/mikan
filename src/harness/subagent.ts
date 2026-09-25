import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentMessage,
  ExecutionToolContext,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Kind, Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MikanModels } from "./models.js";
import type {
  MikanHarnessTool,
  SubagentProfile,
  SubagentModelSpec,
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentUsage,
  SubagentUsageSink,
} from "./types.js";
import { MikanAgentSession, copyUsage, createEmptyUsage } from "./session.js";
import { SessionStore } from "../sessions/session-store.js";

import * as log from "../log.js";

const subagentRunDepth = new AsyncLocalStorage<number>();

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete only the assigned task and return the result directly.";

export const DEFAULT_SUBAGENT_BUDGET = {
  maxTurns: 100,
  maxCostUsd: 10,
  maxDurationMs: 10 * 60 * 1000,
} as const;

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

function isSchemaLiteral(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function hydrateObject(schema: Record<string, unknown>, options: Record<string, unknown>): TSchema {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const props: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    const hydrated = hydrateSchema(value);
    props[key] = required.has(key) ? hydrated : Type.Optional(hydrated);
  }
  return Type.Object(props, options);
}

function hydrateSchema(schema: unknown): TSchema {
  if (isRecord(schema) && Kind in schema) return schema as TSchema;
  if (!isRecord(schema)) return Type.Unknown();

  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.filter(isSchemaLiteral);
    return literals.length > 0
      ? Type.Union(literals.map((value) => Type.Literal(value)))
      : Type.Unknown();
  }
  if ("const" in schema) {
    return isSchemaLiteral(schema.const) ? Type.Literal(schema.const) : Type.Unknown();
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
    case "object":
      return hydrateObject(schema, options);
    case "array":
      return Type.Array(hydrateSchema(schema.items), options);
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

interface RunSubagentOptions<TOutputSchema extends TSchema | undefined = undefined> {
  request: SubagentRunRequest<TOutputSchema>;
  defaultModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  models: MikanModels;
  workspaceDir: string;
  availableTools: MikanHarnessTool[];
  profiles?: ReadonlyMap<string, SubagentProfile>;
  toolContext?: ExecutionToolContext;
  slots?: SubagentSlotPool;
  parentMessages?: AgentMessage[];
  onUsage?: SubagentUsageSink;
  onActivity?: (activity: string) => void;
}

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
      if (characters - reportedAt < ACTIVITY_CHARS_STEP) return;
      reportedAt = characters;
      report(`writing · ${characters} chars`);
      return;
    }
    if (event.type === "auto_retry_start") {
      report("retrying after an error");
    }
  });
}

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

function selectTools(
  requested: string[] | undefined,
  available: MikanHarnessTool[],
): MikanHarnessTool[] {
  if (!requested || requested.length === 0) return [];
  const byName = new Map<string, MikanHarnessTool>();
  for (const tool of available) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool);
  }
  const selected: MikanHarnessTool[] = [];
  for (const name of new Set(requested)) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown or unavailable subagent tool: ${name}`);
    selected.push(tool);
  }
  return selected;
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
  return contentText(message.content, "");
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
  const summary = messages
    .slice(0, recentStart)
    .findLast(
      (message) => message.role === "compactionSummary" || message.role === "branchSummary",
    );
  return [
    "<parent_reference_context>",
    summary ? `Earlier summary: ${messageText(summary)}` : "[Earlier parent context omitted]",
    ...recent.map(
      (message) => `${message.role === "user" ? "User" : "Assistant"}: ${messageText(message)}`,
    ),
    "</parent_reference_context>",
  ].join("\n");
}

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
  return messages.findLast((message): message is AssistantMessage => message.role === "assistant");
}

export async function runSubagent<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  const execution = await executeBoundedSubagentRun(options);
  if (execution.cleanup) {
    void execution.cleanup
      .then(async (result) => {
        await reportSubagentUsage(options.onUsage, result.usage);
      })
      .catch((err) => {
        log.logWarning("Subagent detached cleanup failed", String(err));
      });
    return execution.result;
  }
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

interface BoundedSubagentExecution<TOutput> {
  result: SubagentRunResult<TOutput>;
  cleanup?: Promise<SubagentRunResult<TOutput>>;
}

async function executeBoundedSubagentRun<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<BoundedSubagentExecution<SubagentRunOutput<TOutputSchema>>> {
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
        result: { ...baseRunResult(randomUUID(), model, startedAt), status: "cancelled" },
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
  const budget = { ...request.budget };
  for (const field of ["maxTurns", "maxCostUsd", "maxDurationMs"] as const) {
    const cap = profile[field];
    if (cap !== undefined) budget[field] = Math.min(cap, budget[field] ?? cap);
  }
  if (profile.maxTokens !== undefined || budget.maxTokens !== undefined) {
    budget.maxTokens = Math.max(profile.maxTokens ?? 0, budget.maxTokens ?? 0);
  }
  return {
    ...request,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    model: profile.model || undefined,
    thinkingLevel: profile.thinkingLevel || undefined,
    budget: Object.keys(budget).length > 0 ? budget : undefined,
  };
}

type TerminalSignal = "cancelled" | "timeout";

interface PreparedSubagentRun<TOutputSchema extends TSchema | undefined> {
  request: SubagentRunRequest<TOutputSchema>;
  runId: string;
  startedAt: number;
  modelSpec: SubagentModelSpec;
  session: MikanAgentSession;
  budget: ReturnType<typeof resolveBudget>;
  task: string;
}

function prepareSubagentRun<TOutputSchema extends TSchema | undefined>(
  options: RunSubagentOptions<TOutputSchema>,
  request: SubagentRunRequest<TOutputSchema>,
  runId: string,
  startedAt: number,
): PreparedSubagentRun<TOutputSchema> {
  const model = request.model
    ? options.models.resolve(request.model.provider, request.model.id)
    : options.defaultModel;
  const granted = selectTools(request.tools, options.availableTools);
  const task = formatTask(
    request.task,
    request.input,
    normalizedParentContext(request, options.parentMessages),
  );
  const session = new MikanAgentSession({
    systemPrompt: buildSystemPrompt(
      request.systemPrompt,
      request.outputSchema,
      granted.map((tool) => tool.name),
    ),
    model,
    thinkingLevel: request.thinkingLevel ?? options.thinkingLevel,
    tools: granted,
    toolContext: options.toolContext,
    models: options.models,
    sessionStore: SessionStore.inMemory(options.workspaceDir),
    settings: { compaction: { enabled: false } },
  });
  if (options.onActivity) reportSubagentActivity(session, options.onActivity);
  return {
    request,
    runId,
    startedAt,
    modelSpec: { provider: model.provider, id: model.id },
    session,
    budget: resolveBudget(request.budget),
    task,
  };
}

function buildSubagentResult<TOutputSchema extends TSchema | undefined>(
  run: PreparedSubagentRun<TOutputSchema>,
  terminalSignal: TerminalSignal | undefined,
  cleanupPending = false,
): SubagentRunResult<SubagentRunOutput<TOutputSchema>> {
  const { session, request, budget } = run;
  const stats = session.getLastRunStats();
  const assistant = finalAssistant(session.messages);
  const text = assistant ? contentText(assistant.content, "") : "";
  const base = {
    ...baseRunResult(run.runId, run.modelSpec, run.startedAt, stats),
    text: text || undefined,
    cleanupPending: cleanupPending || undefined,
  };

  if (terminalSignal) {
    return {
      ...base,
      status: terminalSignal,
      error:
        terminalSignal === "timeout"
          ? `Subagent exceeded its ${budget.maxDurationMs}ms duration limit`
          : undefined,
    };
  }
  if (stats.budgetExceededReason) {
    return { ...base, status: "budget_exceeded", error: stats.budgetExceededReason };
  }
  if (assistant?.stopReason === "error") {
    return { ...base, status: "failed", error: assistant.errorMessage || "Subagent failed" };
  }
  if (!assistant) {
    return { ...base, status: "failed", error: "Subagent produced no assistant response" };
  }
  if (!request.outputSchema) {
    return text
      ? { ...base, status: "completed", output: text as SubagentRunOutput<TOutputSchema> }
      : { ...base, status: "failed", error: "Subagent produced no text output" };
  }

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

function buildSubagentFailure<TOutputSchema extends TSchema | undefined>(
  run: PreparedSubagentRun<TOutputSchema>,
  terminalSignal: TerminalSignal | undefined,
  err: unknown,
): SubagentRunResult<SubagentRunOutput<TOutputSchema>> {
  return {
    ...baseRunResult(run.runId, run.modelSpec, run.startedAt, run.session.getLastRunStats()),
    status: terminalSignal ?? "failed",
    error: err instanceof Error ? err.message : String(err),
  };
}

async function executeSubagentPrompt<TOutputSchema extends TSchema | undefined>(
  run: PreparedSubagentRun<TOutputSchema>,
  abortRequested: Promise<void>,
  terminalSignal: () => TerminalSignal | undefined,
): Promise<BoundedSubagentExecution<SubagentRunOutput<TOutputSchema>> | undefined> {
  if (terminalSignal()) return undefined;
  const promptOutcome = subagentRunDepth
    .run(1, () =>
      run.session.prompt(run.task, {
        budget: {
          maxLlmCalls: run.budget.maxTurns,
          maxTokens: run.budget.maxTokens,
          maxCostUsd: run.budget.maxCostUsd,
        },
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
      const outcome = await Promise.race([
        promptOutcome.then((settledOutcome) => ({
          type: "settled" as const,
          outcome: settledOutcome,
        })),
        graceExpired.then((value) => ({ type: value as "expired" })),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      return outcome;
    }),
  ]);
  if (winner.type === "expired") {
    const cleanup = promptOutcome.then((outcome) =>
      outcome.ok
        ? buildSubagentResult(run, terminalSignal())
        : buildSubagentFailure(run, terminalSignal(), outcome.error),
    );
    return { result: buildSubagentResult(run, terminalSignal(), true), cleanup };
  }
  if (!winner.outcome.ok) throw winner.outcome.error;
  return undefined;
}

async function executeSubagentRun<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<BoundedSubagentExecution<SubagentRunOutput<TOutputSchema>>> {
  const request = resolveProfile(options.request, options);
  const runId = randomUUID();
  const startedAt = Date.now();
  const initialModelSpec = request.model ?? {
    provider: options.defaultModel.provider,
    id: options.defaultModel.id,
  };
  let run: PreparedSubagentRun<TOutputSchema> | undefined;
  let terminalSignal: TerminalSignal | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let notifyAbort: () => void = noop;
  const abortRequested = new Promise<void>((resolve) => {
    notifyAbort = resolve;
  });
  const abort = (reason: TerminalSignal) => {
    if (terminalSignal) return;
    terminalSignal = reason;
    run?.session.abort(reason);
    notifyAbort();
  };
  const onAbort = () => abort("cancelled");

  try {
    if ((subagentRunDepth.getStore() ?? 0) >= 1) {
      throw new Error("Nested api.subagent.run calls are not allowed");
    }
    run = prepareSubagentRun(options, request, runId, startedAt);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) abort("cancelled");
    timeout = setTimeout(() => abort("timeout"), run.budget.maxDurationMs);
    timeout.unref();

    const earlyResult = await executeSubagentPrompt(run, abortRequested, () => terminalSignal);
    return earlyResult ?? { result: buildSubagentResult(run, terminalSignal) };
  } catch (err) {
    return {
      result: run
        ? buildSubagentFailure(run, terminalSignal, err)
        : {
            ...baseRunResult(runId, initialModelSpec, startedAt),
            status: terminalSignal ?? "failed",
            error: err instanceof Error ? err.message : String(err),
          },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

export const DEFAULT_GLOBAL_SUBAGENT_SLOTS = 8;

export class SubagentSlotPool {
  private held = 0;
  private waiters: Array<{
    resolve: (release: () => void) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) {
      throw new Error(`SubagentSlotPool capacity must be >= 1, got ${capacity}`);
    }
  }

  get inFlight(): number {
    return this.held;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.held < this.capacity) {
      this.held += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.onAbort!);
        next.resolve(this.releaser());
        return;
      }
      this.held -= 1;
    };
  }
}

export function unboundedSlotPool(): SubagentSlotPool {
  return new SubagentSlotPool(Number.MAX_SAFE_INTEGER);
}
