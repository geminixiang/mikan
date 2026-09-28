import { parseSubagentProgressSnapshot } from "./tools/subagent.js";
import { JEV_TOOL } from "./tools/jev.js";
import { JEV_BROWSER_TOOL } from "./tools/jev-browser.js";
import type { OfficeAddress } from "../types.js";
import * as log from "../log.js";
import { errorMessage } from "../unknown-values.js";
import type { HarnessEvent, RunEvent, RunEventListener } from "./types.js";

const TOOL_CALL_PART_TYPES = new Set(["tool_use", "toolCall", "tool-call"]);

function toolDisplayLabel(toolName: string, args: unknown): string {
  const label = (args as { label?: unknown } | undefined)?.label;
  const text = typeof label === "string" ? label.trim() || toolName : toolName;
  if ((toolName === JEV_TOOL || toolName === JEV_BROWSER_TOOL) && text !== toolName) {
    return `${toolName} · ${text}`;
  }
  return text;
}

function subagentProgressOf(partialResult: unknown) {
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const details = (partialResult as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  return parseSubagentProgressSnapshot((details as { progress?: unknown }).progress);
}

function toolResultContentText(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("content" in result)) return undefined;
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const textParts = (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text);
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  return toolResultContentText(result) ?? JSON.stringify(result);
}

type AssistantMessageEvent = Extract<HarnessEvent, { type: "message_end" }>["message"];

function assistantMessageParts(message: Extract<AssistantMessageEvent, { role: "assistant" }>): {
  thinking: string[];
  text: string;
  callsTools: boolean;
} {
  const thinking: string[] = [];
  const text: string[] = [];
  let callsTools = false;
  for (const part of message.content) {
    if (part.type === "thinking") thinking.push(part.thinking);
    else if (part.type === "text") text.push(part.text);
    if (TOOL_CALL_PART_TYPES.has((part as { type?: string }).type ?? "")) callsTools = true;
  }
  return { thinking, text: text.join("\n"), callsTools };
}

export function toRunEvent(event: HarnessEvent): RunEvent | undefined {
  switch (event.type) {
    case "tool_execution_start":
      return {
        type: "tool_started",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: toolDisplayLabel(event.toolName, event.args),
        args: event.args,
      };
    case "tool_execution_update": {
      const snapshot = subagentProgressOf(event.partialResult);
      return snapshot
        ? { type: "subagent_progress", toolCallId: event.toolCallId, snapshot }
        : undefined;
    }
    case "tool_execution_end":
      return {
        type: "tool_ended",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        resultText: toolResultText(event.result),
      };
    case "message_update": {
      const update = event.assistantMessageEvent;
      return update.type === "text_delta" && update.delta
        ? { type: "assistant_delta", delta: update.delta }
        : undefined;
    }
    case "message_end":
      return event.message.role === "assistant"
        ? { type: "assistant_message", ...assistantMessageParts(event.message) }
        : undefined;
    case "compaction_start":
      return { type: "compaction_started" };
    case "auto_retry_start":
      return { type: "retry_started", attempt: event.attempt, maxAttempts: event.maxAttempts };
    case "budget_exceeded":
      return { type: "budget_exceeded", reason: event.reason };
    default:
      return undefined;
  }
}

function runScopeKey(address: OfficeAddress, sessionKey: string): string {
  return JSON.stringify([address.platform, address.conversationId, sessionKey]);
}

export class RunEventHub {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  subscribe(address: OfficeAddress, sessionKey: string, listener: RunEventListener): () => void {
    const key = runScopeKey(address, sessionKey);
    const scoped = this.listeners.get(key) ?? new Set<RunEventListener>();
    scoped.add(listener);
    this.listeners.set(key, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0 && this.listeners.get(key) === scoped) this.listeners.delete(key);
    };
  }

  publish(address: OfficeAddress, sessionKey: string, event: RunEvent): void {
    const scoped = this.listeners.get(runScopeKey(address, sessionKey));
    if (!scoped) return;
    for (const listener of scoped) {
      try {
        listener(event);
      } catch (error) {
        log.logWarning("Run event listener failed", errorMessage(error));
      }
    }
  }
}
