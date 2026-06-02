import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel as PiAiThinkingLevel } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { resolveConversationSettings, updateConversationSettings } from "../config.js";
import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

const PI_AI_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] satisfies PiAiThinkingLevel[];
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", ...PI_AI_THINKING_LEVELS]);

export interface ParsedModelCommand {
  command: "model" | "/model" | "/pi-model";
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

const MODEL_COMMANDS = ["model", "/model", "/pi-model"] as const;

export function parseModelCommand(text: string): ParsedModelCommand | null {
  const matched = matchCommand(text, MODEL_COMMANDS);
  if (!matched) return null;

  if (matched.args.length === 0) {
    return { command: matched.command };
  }

  const spec = matched.args[0];
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    return { command: matched.command };
  }

  const modelSpec = spec.slice(slash + 1);
  const parsedModel = parseModelThinkingLevel(modelSpec);

  return {
    command: matched.command,
    provider: spec.slice(0, slash),
    model: parsedModel.model,
    thinkingLevel: parsedModel.thinkingLevel,
  };
}

function parseModelThinkingLevel(modelSpec: string): {
  model: string;
  thinkingLevel?: ThinkingLevel;
} {
  const colon = modelSpec.lastIndexOf(":");
  if (colon <= 0 || colon === modelSpec.length - 1) {
    return { model: modelSpec };
  }

  const suffix = modelSpec.slice(colon + 1);
  if (!THINKING_LEVELS.has(suffix as ThinkingLevel)) {
    return { model: modelSpec };
  }

  return {
    model: modelSpec.slice(0, colon),
    thinkingLevel: suffix as ThinkingLevel,
  };
}

function formatModelSpec(provider: string, model: string, thinkingLevel?: ThinkingLevel): string {
  return `${provider}/${model}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
}

function formatModelCommandSummary(lines: string[]): string {
  return formatCommandSummary("Model", lines);
}

export class ModelCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseModelCommand(context.commandText);
    if (!parsed) return false;

    const conversationDir = join(context.services.workingDir, context.conversationId);
    if (!parsed.provider || !parsed.model) {
      const current = resolveConversationSettings(conversationDir);
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatModelCommandSummary([
          `Current: \`${formatModelSpec(current.provider, current.model, current.thinkingLevel)}\``,
          "",
          "Usage: `/pi-model provider/model[:thinking]`",
          "Example: `/pi-model anthropic/claude-sonnet-4-6:off`",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (!this.isKnownModel(parsed.provider, parsed.model)) {
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatModelCommandSummary([
          `找不到模型：\`${formatModelSpec(parsed.provider, parsed.model, parsed.thinkingLevel)}\``,
          "請確認 provider/model 名稱，或先在 pi models.json 註冊自訂模型。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (!context.services.runtime) {
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatModelCommandSummary([
          "Model command is not configured correctly on the server. Please try again later.",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const switched = context.services.runtime.switchConversationModel(
      context.conversationId,
      parsed.provider,
      parsed.model,
    );
    if (!switched) {
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatModelCommandSummary([
          "目前這個 conversation 有執行中的工作，請等它完成或先 `/stop` 後再切換模型。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    updateConversationSettings(conversationDir, {
      provider: parsed.provider,
      model: parsed.model,
      ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
    });

    await replyDiagnosticWithContext(
      context.responseCtx,
      formatModelCommandSummary([
        `Switched: \`${formatModelSpec(parsed.provider, parsed.model, parsed.thinkingLevel)}\``,
        "下一則訊息會使用新模型。",
      ]),
      { style: "muted" },
    );
    return true;
  }

  private isKnownModel(provider: string, model: string): boolean {
    const authStorage = AuthStorage.create(join(homedir(), ".pi", "mikan", "auth.json"));
    const registry = ModelRegistry.create(authStorage);
    return registry.find(provider, model) !== undefined;
  }
}
