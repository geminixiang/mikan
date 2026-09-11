import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel as PiAiThinkingLevel } from "@earendil-works/pi-ai";
import { resolveConversationSettings } from "../config.js";
import { applyConversationSettings } from "../settings-mutation.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler, ModelRegistry, ParsedModelCommand } from "./types.js";
import { replySummary } from "./utils.js";

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
  if (spec === undefined) {
    return { error: "invalid_spec" };
  }
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

const USAGE_EXAMPLE = "Example: `/pi-model anthropic/claude-sonnet-4-6:off`";

type ModelSelection = { modelId: string; thinkingLevel?: ThinkingLevel } | { lines: string[] };

export class ModelCommandHandler implements CommandHandler {
  constructor(private readonly modelRegistry: ModelRegistry) {}
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseModelCommand(context.commandText);
    if (!parsed) return false;

    if (parsed.error) {
      await replySummary(context, "Model", [
        "無效的模型參數，請使用 `provider/model[:thinking]`。",
        USAGE_EXAMPLE,
      ]);
      return true;
    }

    const office = context.services.workspace.office(context.address);
    if (!parsed.provider || !parsed.model) {
      const current = resolveConversationSettings(office);
      await replySummary(context, "Model", [
        `Current: \`${formatModelSpec(current.provider, current.model, current.thinkingLevel)}\``,
        "",
        "Usage: `/pi-model provider/model[:thinking]`",
        USAGE_EXAMPLE,
      ]);
      return true;
    }

    const selection = this.selectModel(parsed.provider, parsed.model, parsed);
    if ("lines" in selection) {
      await replySummary(context, "Model", selection.lines);
      return true;
    }

    if (!context.services.runtime) {
      await replySummary(context, "Model", [
        "Model command is not configured correctly on the server. Please try again later.",
      ]);
      return true;
    }

    const result = applyConversationSettings(context.services.runtime, office, {
      provider: parsed.provider,
      model: selection.modelId,
      ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    });
    if (!result.ok) {
      await replySummary(context, "Model", [
        "目前這個 conversation 有執行中的工作，請等它完成或先 `/stop` 後再切換模型。",
      ]);
      return true;
    }

    await replySummary(context, "Model", [
      `Switched: \`${formatModelSpec(parsed.provider, selection.modelId, selection.thinkingLevel)}\``,
      "下一則訊息會使用新模型。",
    ]);
    return true;
  }

  /**
   * Resolve the spec against the registry. A `:suffix` is first tried as part
   * of the model id, then as a thinking level on the bare id — so a model
   * whose real name contains a colon still wins over the suffix reading.
   */
  private selectModel(provider: string, model: string, parsed: ParsedModelCommand): ModelSelection {
    const exactModelId = parsed.modelCandidate ?? model;
    if (this.modelRegistry.find(provider, exactModelId)) return { modelId: exactModelId };

    if (parsed.modelCandidate) {
      const suffix = parsed.thinkingLevelCandidate;
      if (suffix && !THINKING_LEVELS.has(suffix as ThinkingLevel)) {
        return {
          lines: [
            "未知的 thinking level，請使用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。",
            USAGE_EXAMPLE,
          ],
        };
      }
      if (this.modelRegistry.find(provider, model)) {
        return {
          modelId: model,
          ...(parsed.thinkingLevel ? { thinkingLevel: parsed.thinkingLevel } : {}),
        };
      }
    }

    return {
      lines: [
        `找不到模型：\`${formatModelSpec(provider, model, parsed.thinkingLevel)}\``,
        "請確認 provider/model 名稱，或先在 pi models.json 註冊自訂模型。",
      ],
    };
  }
}
