import { join } from "node:path";
import { updateConversationSettings } from "../config.js";
import { readConversationWorkspaceMountMode } from "../execution-resolver.js";
import { actorKey } from "../sandbox/identity.js";
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
  if (action === "boost" || action === "private" || action === "full") {
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

    const containerKey = actorKey(context.services.sandbox, {
      userId: context.platformUserId,
      conversationId: context.conversationId,
    });

    if (parsed.action === "private" || parsed.action === "full") {
      updateConversationSettings(join(context.services.workingDir, context.conversationId), {
        sandbox: { image: { workspaceMount: parsed.action } },
      });
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Sandbox Workspace", [
          parsed.action === "full"
            ? "已將此 conversation 的 sandbox 設為 full workspace mode。"
            : "已將此 conversation 的 sandbox 設為 private workspace mode。",
          `Workspace mount: ${parsed.action}`,
          parsed.action === "full"
            ? "之後這個 runtime 會把整個 host workspace 掛到 /workspace。"
            : "之後這個 runtime 只會掛載 private workspace 檔案與當前 conversation 目錄。",
        ]),
        { style: "muted" },
      );
      return true;
    }

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
    const workspaceMount = readConversationWorkspaceMountMode(
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
          `Workspace mount: ${workspaceMount}`,
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
