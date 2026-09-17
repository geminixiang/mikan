import { randomUUID } from "node:crypto";
import {
  Usage,
  type AgentInputItem,
  type Model as AgentsModel,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ThinkingLevel,
  type Tool,
} from "@earendil-works/pi-ai";
import type { MikanModels } from "../models.js";

/**
 * OpenAI Agents SDK model adapter backed by mikan's pi-ai model catalog.
 *
 * The Agents SDK owns the agent loop while pi-ai continues to own provider
 * selection, credentials, wire protocols, and provider compatibility.
 */
export class PiAiAgentsModel implements AgentsModel {
  constructor(
    private readonly models: MikanModels,
    private readonly model: Model<Api>,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    return this.complete(request);
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: "response_started" };
    const response = await this.complete(request);
    for (const item of response.output) {
      if (item.type !== "message" && item.type !== undefined) continue;
      if (item.role !== "assistant") continue;
      for (const content of item.content) {
        if (content.type === "output_text") {
          yield { type: "output_text_delta", itemId: item.id, delta: content.text };
        }
      }
    }
    yield {
      type: "response_done",
      response: {
        id: response.responseId ?? randomUUID(),
        ...(response.requestId ? { requestId: response.requestId } : {}),
        usage: response.usage,
        output: response.output as StreamEventResponseOutput,
      },
    };
  }

  private async complete(request: ModelRequest): Promise<ModelResponse> {
    assertSupportedRequest(request);
    const context = toPiContext(request);
    const message = await this.models.models.completeSimple(this.model, context, {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.modelSettings.temperature !== undefined
        ? { temperature: request.modelSettings.temperature }
        : {}),
      ...(request.modelSettings.maxTokens !== undefined
        ? { maxTokens: request.modelSettings.maxTokens }
        : {}),
      ...(toThinkingLevel(request) ? { reasoning: toThinkingLevel(request) } : {}),
      ...(request.modelSettings.toolChoice === "none" ? { toolChoice: "none" as const } : {}),
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `pi-ai request ${message.stopReason}`);
    }
    if (message.stopReason === "deferred") {
      throw new Error("PiAiAgentsModel does not support deferred pi-ai responses.");
    }
    return toAgentsResponse(message);
  }
}

function assertSupportedRequest(request: ModelRequest): void {
  if (request.previousResponseId || request.conversationId || request.prompt) {
    throw new Error(
      "PiAiAgentsModel requires explicit input history; provider-managed conversation state and prompt templates are unsupported.",
    );
  }
  if (request.outputType !== "text") {
    throw new Error("PiAiAgentsModel does not yet support structured model output.");
  }
  if (
    request.modelSettings.toolChoice !== undefined &&
    request.modelSettings.toolChoice !== "auto" &&
    request.modelSettings.toolChoice !== "none"
  ) {
    throw new Error(
      `PiAiAgentsModel does not support toolChoice ${JSON.stringify(request.modelSettings.toolChoice)}.`,
    );
  }
  const unsupportedTool = request.tools.find((tool) => tool.type !== "function");
  if (unsupportedTool) {
    throw new Error(`PiAiAgentsModel does not support ${unsupportedTool.type} tools.`);
  }
}

type FunctionTool = Extract<ModelRequest["tools"][number], { type: "function" }>;
type UserInputContent = Extract<AgentInputItem, { role: "user" }>["content"];
type StreamEventResponseOutput = Extract<
  StreamEvent,
  { type: "response_done" }
>["response"]["output"];

function toPiContext(request: ModelRequest): Context {
  const translated =
    typeof request.input === "string"
      ? { messages: [userMessage(request.input)], systemInstructions: "" }
      : toPiMessages(request.input);
  const functionTools = request.tools.filter(
    (tool): tool is FunctionTool => tool.type === "function",
  );
  const tools: Tool[] = [
    ...functionTools.map((tool) =>
      toPiTool(tool.name, tool.description, tool.parameters, tool.strict),
    ),
    ...request.handoffs.map((handoff) =>
      toPiTool(
        handoff.toolName,
        handoff.toolDescription,
        handoff.inputJsonSchema,
        handoff.strictJsonSchema,
      ),
    ),
  ];
  return {
    ...([request.systemInstructions, translated.systemInstructions].filter(Boolean).join("\n\n")
      ? {
          systemPrompt: [request.systemInstructions, translated.systemInstructions]
            .filter(Boolean)
            .join("\n\n"),
        }
      : {}),
    messages: translated.messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function toPiTool(name: string, description: string, parameters: unknown, strict: boolean): Tool {
  const tool: Tool = {
    name,
    description,
    parameters: parameters as Tool["parameters"],
  };
  if (strict) {
    tool.constrainedSampling = { type: "json_schema", strict: "prefer" };
  }
  return tool;
}

function toPiMessages(items: AgentInputItem[]): {
  messages: Message[];
  systemInstructions: string;
} {
  const messages: Message[] = [];
  let systemText = "";
  for (const item of items) {
    if (item.type === "message" || item.type === undefined) {
      if (item.role === "system") {
        systemText += `${systemText ? "\n\n" : ""}${item.content}`;
        continue;
      }
      if (item.role === "user") {
        messages.push(userMessage(userContentText(item.content)));
        continue;
      }
      if (item.role === "assistant") {
        messages.push(assistantHistoryMessage(item));
        continue;
      }
    }
    if (item.type === "reasoning") {
      appendAssistantContent(messages, {
        type: "thinking",
        thinking:
          item.rawContent?.map((content) => content.text).join("") ??
          item.content.map((content) => content.text).join(""),
      });
      continue;
    }
    if (item.type === "function_call") {
      appendAssistantContent(messages, {
        type: "toolCall",
        id: item.callId,
        name: item.name,
        arguments: parseToolArguments(item.arguments),
        ...(item.namespace ? { namespace: item.namespace } : {}),
      });
      continue;
    }
    if (item.type === "function_call_result") {
      messages.push({
        role: "toolResult",
        toolCallId: item.callId,
        toolName: item.name,
        content: [{ type: "text", text: toolOutputText(item.output) }],
        isError: item.status === "incomplete",
        timestamp: Date.now(),
      });
      continue;
    }
    throw new Error(`PiAiAgentsModel cannot translate Agents SDK input item ${item.type}.`);
  }
  return { messages, systemInstructions: systemText };
}

function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}

function userContentText(content: UserInputContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      throw new Error("PiAiAgentsModel currently supports text-only user content.");
    })
    .join("");
}

function assistantHistoryMessage(
  item: Extract<AgentInputItem, { role: "assistant" }>,
): AssistantMessage {
  return {
    role: "assistant",
    content: item.content.map((content) => {
      if (content.type === "output_text") return { type: "text" as const, text: content.text };
      if (content.type === "refusal") return { type: "text" as const, text: content.refusal };
      throw new Error(`PiAiAgentsModel cannot translate assistant content ${content.type}.`);
    }),
    api: "openai-responses",
    provider: "openai",
    model: "agents-sdk-history",
    usage: emptyPiUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function appendAssistantContent(
  messages: Message[],
  content: AssistantMessage["content"][number],
): void {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    last.content.push(content);
    return;
  }
  messages.push({
    role: "assistant",
    content: [content],
    api: "openai-responses",
    provider: "openai",
    model: "agents-sdk-history",
    usage: emptyPiUsage(),
    stopReason: content.type === "toolCall" ? "toolUse" : "stop",
    timestamp: Date.now(),
  });
}

function parseToolArguments(input: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(input);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agents SDK function-call arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "type" in output) {
    const typed = output as { type: string; text?: string };
    if (typed.type === "text" && typed.text !== undefined) return typed.text;
  }
  return JSON.stringify(output);
}

function toThinkingLevel(request: ModelRequest): ThinkingLevel | undefined {
  const effort = request.modelSettings.reasoning?.effort;
  if (!effort || effort === "none") return undefined;
  return effort;
}

function toAgentsResponse(message: AssistantMessage): ModelResponse {
  const output: ModelResponse["output"] = [];
  let pendingText = "";
  const flushText = (): void => {
    if (!pendingText) return;
    output.push({
      type: "message",
      role: "assistant",
      status: message.stopReason === "length" ? "incomplete" : "completed",
      content: [{ type: "output_text", text: pendingText }],
    });
    pendingText = "";
  };
  for (const content of message.content) {
    if (content.type === "text") {
      pendingText += content.text;
      continue;
    }
    flushText();
    if (content.type === "thinking" && content.thinking) {
      output.push({
        type: "reasoning",
        content: [{ type: "input_text", text: content.thinking }],
        rawContent: [{ type: "reasoning_text", text: content.thinking }],
      });
    }
    if (content.type === "toolCall") {
      output.push({
        type: "function_call",
        callId: content.id,
        name: content.name,
        arguments: JSON.stringify(content.arguments),
        status: "completed",
        ...(content.namespace ? { namespace: content.namespace } : {}),
      });
    }
  }
  flushText();
  return {
    usage: new Usage({
      requests: 1,
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      totalTokens: message.usage.totalTokens,
      inputTokensDetails: { cached_tokens: message.usage.cacheRead },
      outputTokensDetails:
        message.usage.reasoning === undefined ? {} : { reasoning_tokens: message.usage.reasoning },
    }),
    output,
    ...(message.responseId ? { responseId: message.responseId } : {}),
  };
}

function emptyPiUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
