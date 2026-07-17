import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { MikanModels } from "./models.js";
import { MikanAgentSession } from "./runner.js";
import { SessionStore } from "./session-store.js";
import type { SubagentRunOutput, SubagentRunRequest, SubagentRunResult } from "./types.js";

const subagentRunDepth = new AsyncLocalStorage<number>();
const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete only the assigned task and return the result directly.";
const DEFAULT_SUBAGENT_BUDGET = {
  maxTurns: 8,
  maxCostUsd: 0.5,
  maxDurationMs: 2 * 60 * 1000,
} as const;

interface RunSubagentOptions<TOutputSchema extends TSchema | undefined = undefined> {
  request: SubagentRunRequest<TOutputSchema>;
  defaultModel: Model<Api>;
  thinkingLevel: ThinkingLevel;
  models: MikanModels;
  workspaceDir: string;
  availableTools: AgentTool[];
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

function formatTask(task: string, input: unknown): string {
  const trimmed = task.trim();
  if (!trimmed) throw new Error("api.subagent.run requires a non-empty task");
  if (input === undefined) return trimmed;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input, null, 2);
  } catch (err) {
    throw new Error(
      `api.subagent.run input must be JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (serialized === undefined) {
    throw new Error("api.subagent.run input must be JSON-serializable");
  }
  return `${trimmed}\n\nInput:\n${serialized}`;
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

/** Execute one non-recursive, fresh subagent run for an extension. */
export async function runSubagent<TOutputSchema extends TSchema | undefined = undefined>(
  options: RunSubagentOptions<TOutputSchema>,
): Promise<SubagentRunResult<SubagentRunOutput<TOutputSchema>>> {
  if ((subagentRunDepth.getStore() ?? 0) >= 1) {
    throw new Error("Nested api.subagent.run calls are not allowed");
  }

  const { request } = options;
  const runId = randomUUID();
  const startedAt = Date.now();
  const model = request.model
    ? options.models.resolve(request.model.provider, request.model.id)
    : options.defaultModel;
  const modelSpec = { provider: model.provider, id: model.id };
  const tools = selectTools(request.tools, options.availableTools);
  const task = formatTask(request.task, request.input);
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

  let terminalSignal: "cancelled" | "timeout" | undefined;
  const abort = (reason: "cancelled" | "timeout") => {
    if (terminalSignal) return;
    terminalSignal = reason;
    session.abort();
  };
  const onAbort = () => abort("cancelled");
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) abort("cancelled");
  const timeout = setTimeout(() => abort("timeout"), budget.maxDurationMs);
  timeout?.unref();

  try {
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

    if (terminalSignal) return { ...base, status: terminalSignal };
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
      if (!Value.Check(request.outputSchema, parsed)) {
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

    return {
      ...base,
      status: "completed",
      output: text as SubagentRunOutput<TOutputSchema>,
    };
  } catch (err) {
    const stats = session.getLastRunStats();
    return {
      runId,
      status: terminalSignal ?? "failed",
      model: modelSpec,
      turns: stats.llmCalls,
      tokens: stats.tokens,
      costUsd: stats.costUsd,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
