import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel as PiAiThinkingLevel } from "@earendil-works/pi-ai";
import { resolveConversationSettings } from "../config.js";
import { applyConversationSettings } from "../settings-mutation.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler, ModelRegistry, ParsedModelCommand } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

const PI_AI_THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies PiAiThinkingLevel[];
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", ...PI_AI_THINKING_LEVELS]);

export type { ParsedModelCommand } from "./types.js";

const MODEL_COMMANDS = slashForms("model");

export function parseModelCommand(text: string): ParsedModelCommand | null {
  const matched = matchCommand(text, MODEL_COMMANDS);
  if (!matched) return null;

  if (matched.args.length === 0) {
    return {};
  }

  if (matched.args.length !== 1) {
    return { error: "invalid_spec" };
  }

  const spec = matched.args[0];
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    return { error: "invalid_spec" };
  }

  const modelSpec = spec.slice(slash + 1);
  const parsedModel = parseModelThinkingLevel(modelSpec);
  if (parsedModel.error) {
    return { error: parsedModel.error };
  }

  return {
    provider: spec.slice(0, slash),
    ...parsedModel,
  };
}

function parseModelThinkingLevel(modelSpec: string): {
  model?: string;
  modelCandidate?: string;
  thinkingLevelCandidate?: string;
  thinkingLevel?: ThinkingLevel;
  error?: "invalid_spec";
} {
  const colon = modelSpec.lastIndexOf(":");
  if (colon === 0 || colon === modelSpec.length - 1) {
    return { error: "invalid_spec" };
  }
  if (colon < 0) {
    return { model: modelSpec };
  }

  const suffix = modelSpec.slice(colon + 1);
  return {
    model: modelSpec.slice(0, colon),
    modelCandidate: modelSpec,
    thinkingLevelCandidate: suffix,
    ...(THINKING_LEVELS.has(suffix as ThinkingLevel)
      ? { thinkingLevel: suffix as ThinkingLevel }
      : {}),
  };
}

function formatModelSpec(provider: string, model: string, thinkingLevel?: ThinkingLevel): string {
  return `${provider}/${model}${thinkingLevel ? `:${thinkingLevel}` : ""}`;
}

export class ModelCommandHandler implements CommandHandler {
  constructor(private readonly modelRegistry: ModelRegistry) {}
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseModelCommand(context.commandText);
    if (!parsed) return false;

    if (parsed.error) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Model", [
          "無效的模型參數，請使用 `provider/model[:thinking]`。",
          "Example: `/pi-model anthropic/claude-sonnet-4-6:off`",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const office = context.services.workspace.office(context.address);
    if (!parsed.provider || !parsed.model) {
      const current = resolveConversationSettings(office);
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Model", [
          `Current: \`${formatModelSpec(current.provider, current.model, current.thinkingLevel)}\``,
          "",
          "Usage: `/pi-model provider/model[:thinking]`",
          "Example: `/pi-model anthropic/claude-sonnet-4-6:off`",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const exactModelId = parsed.modelCandidate ?? parsed.model;
    let selectedModelId = exactModelId;
    let selectedThinkingLevel = parsed.thinkingLevel;
    let registeredModel = this.modelRegistry.find(parsed.provider, exactModelId);

    if (!registeredModel && parsed.modelCandidate) {
      if (
        parsed.thinkingLevelCandidate &&
        !THINKING_LEVELS.has(parsed.thinkingLevelCandidate as ThinkingLevel)
      ) {
        await replyDiagnosticWithContext(
          context.responder,
          formatCommandSummary("Model", [
            "未知的 thinking level，請使用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。",
            "Example: `/pi-model anthropic/claude-sonnet-4-6:off`",
          ]),
          { style: "muted" },
        );
        return true;
      }

      selectedModelId = parsed.model;
      registeredModel = this.modelRegistry.find(parsed.provider, selectedModelId);
    }

    if (!registeredModel) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Model", [
          `找不到模型：\`${formatModelSpec(parsed.provider, selectedModelId, selectedThinkingLevel)}\``,
          "請確認 provider/model 名稱，或先在 pi models.json 註冊自訂模型。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (parsed.modelCandidate && selectedModelId === parsed.modelCandidate) {
      selectedThinkingLevel = undefined;
    }

    if (!context.services.runtime) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Model", [
          "Model command is not configured correctly on the server. Please try again later.",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const result = applyConversationSettings(context.services.runtime, office, {
      provider: parsed.provider,
      model: selectedModelId,
      ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
    });
    if (!result.ok) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Model", [
          "目前這個 conversation 有執行中的工作，請等它完成或先 `/stop` 後再切換模型。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    await replyDiagnosticWithContext(
      context.responder,
      formatCommandSummary("Model", [
        `Switched: \`${formatModelSpec(parsed.provider, selectedModelId, selectedThinkingLevel)}\``,
        "下一則訊息會使用新模型。",
      ]),
      { style: "muted" },
    );
    return true;
  }
}
