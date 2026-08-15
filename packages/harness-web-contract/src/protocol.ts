import type { HarnessCommand, HarnessThinkingLevel } from "./types.js";

const THINKING_LEVELS = new Set<HarnessThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MAX_PROMPT_LENGTH = 100_000;

export class HarnessProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessProtocolError";
  }
}

export function parseHarnessCommand(value: unknown): HarnessCommand {
  const command = requireRecord(value, "Harness command");
  const kind = requireString(command.kind, "Harness command kind");
  const commandId = requireString(command.commandId, "Harness command id");

  switch (kind) {
    case "create-conversation":
      return { kind, commandId };
    case "prompt": {
      const text = requireString(command.text, "Prompt text", true);
      if (text.length > MAX_PROMPT_LENGTH) {
        throw new HarnessProtocolError(`Prompt text exceeds ${MAX_PROMPT_LENGTH} characters`);
      }
      return {
        kind,
        commandId,
        officeKey: requireString(command.officeKey, "Office key"),
        sessionId: requireString(command.sessionId, "Session id"),
        text,
      };
    }
    case "cancel-run":
      return {
        kind,
        commandId,
        officeKey: requireString(command.officeKey, "Office key"),
        sessionId: requireString(command.sessionId, "Session id"),
        runId: requireString(command.runId, "Run id"),
      };
    case "set-model":
      return {
        kind,
        commandId,
        officeKey: requireString(command.officeKey, "Office key"),
        sessionId: requireString(command.sessionId, "Session id"),
        provider: requireString(command.provider, "Model provider"),
        model: requireString(command.model, "Model id"),
        thinkingLevel: requireThinkingLevel(command.thinkingLevel),
      };
    default:
      throw new HarnessProtocolError(`Unknown Harness command kind: ${JSON.stringify(kind)}`);
  }
}

function requireThinkingLevel(value: unknown): HarnessThinkingLevel {
  if (typeof value === "string" && THINKING_LEVELS.has(value as HarnessThinkingLevel)) {
    return value as HarnessThinkingLevel;
  }
  throw new HarnessProtocolError("Thinking level is invalid");
}

function requireString(value: unknown, label: string, allowBlank = false): string {
  if (typeof value !== "string") throw new HarnessProtocolError(`${label} must be a string`);
  const normalized = allowBlank ? value : value.trim();
  if (!allowBlank && normalized.length === 0) {
    throw new HarnessProtocolError(`${label} must not be blank`);
  }
  if (allowBlank && value.trim().length === 0) {
    throw new HarnessProtocolError(`${label} must not be blank`);
  }
  return normalized;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
