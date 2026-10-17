import { randomUUID } from "node:crypto";
import {
  contentText,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
} from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { MikanModels } from "./models.js";
import type { SessionEntry } from "../sessions/types.js";
import type {
  SubagentProfile,
  SubagentModelSpec,
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentConversationHooks,
  SubagentToolCall,
  SubagentToolCallView,
} from "./types.js";
import {
  AgentDoc,
  AssistantEntry,
  UsageDoc,
  configure,
  type AgentChange,
  type ConversationId,
  type EntryId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { OWNER_ONLY_EXTENSIONS, addUsage, createEmptyUsage, sumUsageState } from "./session.js";

import * as log from "../log.js";
import { errorMessage, isRecord } from "../unknown-values.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete only the assigned task and return the result directly.";

const DEFAULT_SUBAGENT_BUDGET = {
  maxTurns: 100,
  maxCostUsd: 10,
  maxDurationMs: 10 * 60 * 1000,
} as const;

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
  if (isRecord(schema) && "~kind" in schema) return schema;
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

function resolveBudget(budget: SubagentRunRequest["budget"]) {
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

function formatTask(task: string, input: unknown, parentContext?: string): string {
  const trimmed = task.trim();
  if (!trimmed) throw new Error("api.subagent.run requires a non-empty task");
  let formatted = trimmed;
  if (input !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(input, null, 2);
    } catch (err) {
      throw new Error(`api.subagent.run input must be JSON-serializable: ${errorMessage(err)}`, {
        cause: err,
      });
    }
    if (serialized === undefined)
      throw new Error("api.subagent.run input must be JSON-serializable");
    formatted = `${trimmed}\n\nInput:\n${serialized}`;
  }
  return parentContext ? `${parentContext}\n\n${formatted}` : formatted;
}

function messageText(message: Message): string {
  if (!("content" in message)) return "";
  return contentText(message.content, "");
}

function normalizedParentContext(
  request: SubagentRunRequest<TSchema | undefined>,
  entries: SessionEntry[] | undefined,
): string | undefined {
  if (!request.parentContext || !entries) return undefined;
  const recentTurns = request.parentContext.recentTurns ?? 3;
  if (!Number.isInteger(recentTurns) || recentTurns < 1 || recentTurns > 8) {
    throw new Error("api.subagent.run parentContext.recentTurns must be an integer from 1 to 8");
  }
  const compaction = entries.findLast((entry) => entry.type === "compaction");
  const visible = compaction ? entries.slice(entries.indexOf(compaction) + 1) : entries;
  const conversation = visible.flatMap((entry) =>
    entry.type === "message" &&
    (entry.message.role === "user" || entry.message.role === "assistant") &&
    messageText(entry.message)
      ? [entry.message]
      : [],
  );
  let first = conversation.length;
  let users = 0;
  while (first > 0 && users < recentTurns) {
    first -= 1;
    if (conversation[first]?.role === "user") users += 1;
  }
  const recent = conversation.slice(first);
  return [
    "<parent_reference_context>",
    compaction ? `Earlier summary: ${compaction.summary}` : "[Earlier parent context omitted]",
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

function baseRunResult(runId: string, model: SubagentModelSpec, startedAt: number) {
  const usage = createEmptyUsage();
  return {
    runId,
    model,
    turns: 0,
    toolCalls: 0,
    toolCallCounts: {},
    usage,
    tokens: usage.totalTokens,
    costUsd: usage.cost.total,
    durationMs: Date.now() - startedAt,
  };
}

function noop(): void {}

type TerminalSignal = "cancelled" | "timeout";

function resolveProfile<TOutputSchema extends TSchema | undefined>(
  request: SubagentRunRequest<TOutputSchema>,
  options: { profiles?: ReadonlyMap<string, SubagentProfile> },
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

interface AnswerClassification<TOutputSchema extends TSchema | undefined> {
  base: ReturnType<typeof baseRunResult>;
  request: SubagentRunRequest<TOutputSchema>;
  assistant: AssistantMessage | undefined;
  terminalSignal: TerminalSignal | undefined;
  budgetExceededReason: string | undefined;
  maxDurationMs: number;
}

function classifyAnswer<TOutputSchema extends TSchema | undefined>(
  answer: AnswerClassification<TOutputSchema>,
): SubagentRunResult<SubagentRunOutput<TOutputSchema>> {
  const { request, assistant, terminalSignal } = answer;
  const text = assistant ? contentText(assistant.content, "") : "";
  const base = { ...answer.base, text: text || undefined };

  if (terminalSignal) {
    return {
      ...base,
      status: terminalSignal,
      error:
        terminalSignal === "timeout"
          ? `Subagent exceeded its ${answer.maxDurationMs}ms duration limit`
          : undefined,
    };
  }
  if (answer.budgetExceededReason) {
    return { ...base, status: "budget_exceeded", error: answer.budgetExceededReason };
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

interface ChildSubagentOptions<TOutputSchema extends TSchema | undefined> {
  request: SubagentRunRequest<TOutputSchema>;
  key: string;
  call: SubagentToolCall;
  defaultModel: Model<Api>;
  models: MikanModels;
  availableTools: ReadonlySet<string>;
  profiles: ReadonlyMap<string, SubagentProfile>;
  slots: SubagentSlotPool;
  parentEntries?: SessionEntry[];
  onActivity?: (activity: string) => void;
  track: (conversationId: ConversationId, hooks: SubagentConversationHooks) => () => void;
}

class ChildRun implements SubagentConversationHooks {
  llmCalls = 0;
  toolCalls = 0;
  readonly toolCallCounts: Record<string, number> = {};
  terminalSignal: TerminalSignal | undefined;
  budgetExceededReason: string | undefined;
  private overBudget: string | undefined;
  private readonly usage = createEmptyUsage();

  constructor(
    private readonly budget: ReturnType<typeof resolveBudget>,
    private readonly abort: () => void,
    private readonly onActivity: ((activity: string) => void) | undefined,
  ) {}

  beforeRequest(): void {
    const reason = this.overBudget ?? this.callLimitReason();
    if (reason) return this.exceed(reason);
    this.llmCalls += 1;
    this.report("thinking");
  }

  afterResponse(message: AssistantMessage): void {
    addUsage(this.usage, message.usage);
    const { maxTokens, maxCostUsd } = this.budget;
    const needsCall =
      message.stopReason === "error" || message.content.some((part) => part.type === "toolCall");
    if (maxTokens !== undefined && this.usage.totalTokens >= maxTokens)
      this.overBudget = `${this.usage.totalTokens} tokens >= ${maxTokens} limit`;
    else if (this.usage.cost.total >= maxCostUsd)
      this.overBudget = `cost ${this.usage.cost.total.toFixed(2)} USD >= ${maxCostUsd} USD limit`;
    else if (needsCall) this.overBudget = this.callLimitReason();
  }

  beforeTool(call: SubagentToolCallView): { block: string } | undefined {
    if (this.overBudget) {
      this.exceed(this.overBudget);
      return { block: this.overBudget };
    }
    this.toolCalls += 1;
    this.toolCallCounts[call.name] = (this.toolCallCounts[call.name] ?? 0) + 1;
    const label = typeof call.arguments.label === "string" ? call.arguments.label : "";
    this.report(label ? `${call.name}: ${label}` : call.name);
    return undefined;
  }

  stop(signal: TerminalSignal): void {
    if (this.terminalSignal || this.budgetExceededReason) return;
    this.terminalSignal = signal;
    this.abort();
  }

  private callLimitReason(): string | undefined {
    const limit = this.budget.maxTurns;
    return this.llmCalls >= limit ? `${this.llmCalls} LLM calls >= ${limit} limit` : undefined;
  }

  private exceed(reason: string): void {
    if (this.terminalSignal || this.budgetExceededReason) return;
    this.budgetExceededReason = reason;
    this.abort();
  }

  private report(activity: string): void {
    try {
      this.onActivity?.(activity);
    } catch (err) {
      log.logWarning("Subagent onActivity listener failed", String(err));
    }
  }
}

function grantedTools(
  call: SubagentToolCall,
  requested: string[] | undefined,
  available: ReadonlySet<string>,
): ToolRegistration[] {
  if (!requested || requested.length === 0) return [];
  const registered = new Map<string, ToolRegistration>();
  for (const { tool } of call.api.registry.tools()) {
    if (!registered.has(tool.name)) registered.set(tool.name, tool);
  }
  return [...new Set(requested)].map((name) => {
    const tool = available.has(name) ? registered.get(name) : undefined;
    if (!tool) throw new Error(`Unknown or unavailable subagent tool: ${name}`);
    return tool;
  });
}

async function childExtensions({ api, context }: SubagentToolCall): Promise<Extension[]> {
  const owner = (await api.snapshot(AgentDoc, api.conversationId, context))?.extensions;
  const selected = Array.isArray(owner) ? owner : [];
  return selected.flatMap((name) => {
    const extension = OWNER_ONLY_EXTENSIONS.includes(name)
      ? undefined
      : api.registry.extension(name);
    return extension ? [extension] : [];
  });
}

async function childConversation(
  { api, context }: SubagentToolCall,
  key: string,
  agent: AgentChange,
): Promise<ConversationId> {
  const name = `subagent:${api.callId}:${key}`;
  const known = await api.memo<ConversationId>(name, context);
  if (known !== undefined) return known;
  const created = await api.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "task", taskId: api.taskId },
    });
    await configure(tx, conversation.id, agent);
    return conversation.id;
  }, context);
  return api.memo<ConversationId>(name, created, context);
}

async function answerMessage(
  { api, context }: SubagentToolCall,
  answer: EntryId,
): Promise<AssistantMessage | undefined> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0];
  return message?.role === "assistant" ? message : undefined;
}

async function createChild<TOutputSchema extends TSchema | undefined>(
  options: ChildSubagentOptions<TOutputSchema>,
  request: SubagentRunRequest<TOutputSchema>,
): Promise<{ child: ConversationId; task: string }> {
  const tools = grantedTools(options.call, request.tools, options.availableTools);
  const task = formatTask(
    request.task,
    request.input,
    normalizedParentContext(request, options.parentEntries),
  );
  const model = request.model
    ? options.models.resolve(request.model.provider, request.model.id)
    : options.defaultModel;
  const child = await childConversation(options.call, options.key, {
    extensions: await childExtensions(options.call),
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: request.thinkingLevel,
    tools,
    modelTools: tools,
    instructions: buildSystemPrompt(
      request.systemPrompt,
      request.outputSchema,
      tools.map((tool) => tool.name),
    ),
  });
  return { child, task };
}

export async function runChildSubagent<TOutputSchema extends TSchema | undefined = undefined>(
  options: ChildSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  const startedAt = Date.now();
  const { call } = options;
  const signal = call.context.abortSignal;
  const request = resolveProfile(options.request, options);
  const modelSpec = request.model ?? {
    provider: options.defaultModel.provider,
    id: options.defaultModel.id,
  };
  let release: () => void;
  try {
    release = await options.slots.acquire(signal);
  } catch (err) {
    if (!(err instanceof Error && err.name === "AbortError")) throw err;
    return { ...baseRunResult(randomUUID(), modelSpec, startedAt), status: "cancelled" };
  }
  let run: ChildRun | undefined;
  let runId: string = randomUUID();
  let timeout: NodeJS.Timeout | undefined;
  let untrack = noop;
  const onAbort = () => run?.stop("cancelled");
  try {
    const budget = resolveBudget(request.budget);
    const { child, task } = await createChild(options, request);
    runId = String(child);
    const handle = await call.api.conversation(child, call.context);
    if (!handle) throw new Error(`Subagent conversation ${child} is missing`);
    const childRun = new ChildRun(
      budget,
      () => void handle.abort(call.context).catch(() => undefined),
      options.onActivity,
    );
    run = childRun;
    untrack = options.track(child, childRun);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) childRun.stop("cancelled");
    timeout = setTimeout(() => childRun.stop("timeout"), budget.maxDurationMs);
    timeout.unref();
    const submission = await handle.submit(
      { type: "input", content: task, requestId: `subagent:${call.api.callId}:${options.key}` },
      call.context,
    );
    const settled = await submission.wait(call.context);
    const usage = sumUsageState(
      (await call.api.snapshot(UsageDoc, child, call.context)) ?? { models: {}, tools: {} },
    );
    const base = {
      ...baseRunResult(runId, modelSpec, startedAt),
      turns: childRun.llmCalls,
      toolCalls: childRun.toolCalls,
      toolCallCounts: { ...childRun.toolCallCounts },
      usage,
      tokens: usage.totalTokens,
      costUsd: usage.cost.total,
    };
    if (settled.status !== "done" && !childRun.terminalSignal && !childRun.budgetExceededReason) {
      return { ...base, status: "failed", error: `Subagent ${settled.reason ?? "unanswered"}` };
    }
    return classifyAnswer({
      base,
      request,
      assistant:
        settled.status === "done" && settled.type === "input"
          ? await answerMessage(call, settled.answer)
          : undefined,
      terminalSignal: childRun.terminalSignal,
      budgetExceededReason: childRun.budgetExceededReason,
      maxDurationMs: budget.maxDurationMs,
    });
  } catch (err) {
    return {
      ...baseRunResult(runId, modelSpec, startedAt),
      status: run?.terminalSignal ?? "failed",
      error: errorMessage(err),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    untrack();
    release();
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
