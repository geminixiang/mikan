import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Kind, Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as log from "../log.js";
import type { MikanModels } from "./models.js";
import { MikanAgentSession } from "./runner.js";
import { SessionStore } from "./session-store.js";
import type {
  SubagentModelSpec,
  SubagentRunOutput,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentUsage,
} from "./types.js";
import { unboundedSlotPool, type SubagentSlotPool } from "../tools/subagent-slots.js";

const subagentRunDepth = new AsyncLocalStorage<number>();
const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete only the assigned task and return the result directly.";
export const DEFAULT_SUBAGENT_BUDGET = {
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

interface RunSubagentOptions<TOutputSchema extends TSchema | undefined = undefined> {
  request: SubagentRunRequest<TOutputSchema>;
  defaultModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  models: MikanModels;
  workspaceDir: string;
  availableTools: AgentTool[];
  /** Process-wide launch pool shared by tool and extension invocations. */
  slots?: SubagentSlotPool;
  /** Host-snapshotted parent transcript; never sourced from the public request. */
  parentMessages?: AgentMessage[];
  /** Usage attribution snapshotted when this invocation begins. */
  onUsage?: (usage: SubagentUsage) => void | Promise<void>;
}

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
    if (conversation[first].role === "user") users += 1;
  }
  const recent = conversation.slice(first);
  const recentStart = recent[0] ? messages.indexOf(recent[0]) : messages.length;
  let summary: AgentMessage | undefined;
  for (let index = recentStart - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "compactionSummary" || message.role === "branchSummary") {
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

function buildSystemPrompt(base: string | undefined, outputSchema: TSchema | undefined): string {
  const prompt = base?.trim() || DEFAULT_SYSTEM_PROMPT;
  if (!outputSchema) return prompt;
  return [
    prompt,
    "",
    "Return only one JSON value matching this JSON Schema. Do not use Markdown or code fences.",
    JSON.stringify(outputSchema),
  ].join("\n");
}

function finalAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant") return message;
  }
  return undefined;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Execute one non-recursive, fresh subagent run. Never rejects: every
 * failure — including request validation — is a result with a terminal
 * status, so batch callers (`tasks` / `dag`) can never orphan in-flight
 * sibling runs on one bad request. The run's spend is reported through
 * `onUsage` before the result is returned.
 */
export async function runSubagent<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  const result = await executeBoundedSubagentRun(options);
  try {
    await options.onUsage?.({ tokens: result.tokens, costUsd: result.costUsd });
  } catch (err) {
    log.logWarning("Subagent onUsage listener failed", String(err));
  }
  return result;
}

async function executeBoundedSubagentRun<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  const startedAt = Date.now();
  let release: (() => void) | undefined;
  try {
    release = await (options.slots ?? unboundedSlotPool()).acquire(options.request.signal);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        runId: randomUUID(),
        status: "cancelled",
        model: options.request.model ?? {
          provider: options.defaultModel.provider,
          id: options.defaultModel.id,
        },
        turns: 0,
        tokens: 0,
        costUsd: 0,
        durationMs: Date.now() - startedAt,
      };
    }
    throw err;
  }
  try {
    return await executeSubagentRun(options);
  } finally {
    release();
  }
}

async function executeSubagentRun<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  const { request } = options;
  const runId = randomUUID();
  const startedAt = Date.now();
  let modelSpec: SubagentModelSpec = request.model ?? {
    provider: options.defaultModel.provider,
    id: options.defaultModel.id,
  };
  let sessionRef: MikanAgentSession | undefined;
  let terminalSignal: "cancelled" | "timeout" | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const abort = (reason: "cancelled" | "timeout") => {
    if (terminalSignal) return;
    terminalSignal = reason;
    sessionRef?.abort();
  };
  const onAbort = () => abort("cancelled");

  try {
    if ((subagentRunDepth.getStore() ?? 0) >= 1) {
      throw new Error("Nested api.subagent.run calls are not allowed");
    }
    const model = request.model
      ? options.models.resolve(request.model.provider, request.model.id)
      : options.defaultModel;
    modelSpec = { provider: model.provider, id: model.id };
    const tools = selectTools(request.tools, options.availableTools);
    const task = formatTask(
      request.task,
      request.input,
      normalizedParentContext(request, options.parentMessages),
    );
    const budget = resolveBudget(request.budget);
    const session = new MikanAgentSession({
      systemPrompt: buildSystemPrompt(request.systemPrompt, request.outputSchema),
      model,
      thinkingLevel: options.thinkingLevel,
      tools,
      models: options.models,
      sessionStore: SessionStore.inMemory(options.workspaceDir),
      settings: { compaction: { enabled: false } },
    });
    sessionRef = session;

    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) abort("cancelled");
    timeout = setTimeout(() => abort("timeout"), budget.maxDurationMs);
    timeout.unref();

    if (!terminalSignal) {
      await subagentRunDepth.run(1, () =>
        session.prompt(task, {
          budget: {
            maxLlmCalls: budget.maxTurns,
            maxTokens: budget.maxTokens,
            maxCostUsd: budget.maxCostUsd,
            maxDurationMs: budget.maxDurationMs,
          },
        }),
      );
    }

    const stats = session.getLastRunStats();
    const assistant = finalAssistant(session.messages);
    const text = assistantText(assistant);
    const base = {
      runId,
      model: modelSpec,
      turns: stats.llmCalls,
      tokens: stats.tokens,
      costUsd: stats.costUsd,
      durationMs: Date.now() - startedAt,
      ...(text ? { text } : {}),
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
  } catch (err) {
    const stats = sessionRef?.getLastRunStats();
    return {
      runId,
      status: terminalSignal ?? "failed",
      model: modelSpec,
      turns: stats?.llmCalls ?? 0,
      tokens: stats?.tokens ?? 0,
      costUsd: stats?.costUsd ?? 0,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
