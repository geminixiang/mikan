import { resolveWorkspaceProjection } from "../workspace-projection/index.js";
import { runtimeResourceKey } from "../sandbox/identity.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler, ParsedSandboxCommand } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

export type { ParsedSandboxCommand } from "./types.js";

const SANDBOX_COMMANDS = slashForms("sandbox");

export function parseSandboxCommand(text: string): ParsedSandboxCommand | null {
  const matched = matchCommand(text, SANDBOX_COMMANDS, { stripMention: true });
  if (!matched) return null;

  const action = matched.args.length === 1 ? matched.args[0].toLowerCase() : undefined;
  if (action === "boost") {
    return { action };
  }
  return {};
}

export class SandboxCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseSandboxCommand(context.commandText);
    if (!parsed) return false;

    if (
      (context.services.sandbox.type !== "image" && context.services.sandbox.type !== "gondolin") ||
      !context.services.resourceController
    ) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Sandbox", [
          "`/pi-sandbox` 目前只支援 `image:*` 與 `gondolin:*` managed sandbox。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const containerKey = runtimeResourceKey(context.services.sandbox, {
      userId: context.platformUserId,
      conversationId: context.conversationId,
    });

    if (parsed.action === "boost") {
      const boostLimits = context.services.resourceController.getBoostLimits();
      if (!boostLimits?.cpus && !boostLimits?.memory) {
        await replyDiagnosticWithContext(
          context.responder,
          formatCommandSummary("Sandbox Boost", [
            "此 mikan instance 尚未設定 sandbox boost 規格。",
            "請先在全域 settings.json 設定 `sandbox.boost`。",
          ]),
          { style: "muted" },
        );
        return true;
      }

      const status = await context.services.resourceController.boost(containerKey);
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Sandbox Boost", [
          "已暫時提升此 conversation 的 sandbox 規格。",
          `Current: ${formatLimits(status.limits)}`,
          "boost 會在此 sandbox runtime 關閉後結束。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const status = context.services.resourceController.getLimitStatus(containerKey);
    const defaultLimits = context.services.resourceController.getDefaultLimits();
    const boostLimits = context.services.resourceController.getBoostLimits();
    const workspace = resolveWorkspaceProjection(
      context.services.workingDir,
      context.conversationId,
    );
    await replyDiagnosticWithContext(
      context.responder,
      formatCommandSummary(
        "Sandbox",
        [
          `Current: ${formatLimits(status.limits)}`,
          `Status: ${status.boosted ? "boosted" : "default"}`,
          `Workspace policy: ${workspace.doorPolicy}`,
          `Workspace layout: ${workspace.layout}`,
          "",
          `Default: ${formatLimits(defaultLimits)}`,
          boostLimits ? `Boost: ${formatLimits({ ...defaultLimits, ...boostLimits })}` : undefined,
        ].filter((line): line is string => line !== undefined),
      ),
      { style: "muted" },
    );
    return true;
  }
}

function formatLimits(limits: { cpus?: string; memory?: string } | undefined): string {
  return `CPU ${limits?.cpus ?? "unlimited"} / Memory ${limits?.memory ?? "unlimited"}`;
}
