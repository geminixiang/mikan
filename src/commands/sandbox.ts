import { join } from "node:path";
import { updateConversationSettings } from "../config.js";
import { readConversationWorkspaceMountMode } from "../execution-resolver.js";
import { resolveActorVaultKey } from "../vault-routing.js";
import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

export interface ParsedSandboxCommand {
  command: "/pi-sandbox" | "/sandbox";
  action?: "boost" | "private" | "full";
}

const SANDBOX_COMMANDS = ["/pi-sandbox", "/sandbox"] as const;

export function parseSandboxCommand(text: string): ParsedSandboxCommand | null {
  const matched = matchCommand(text, SANDBOX_COMMANDS, { stripMention: true });
  if (!matched) return null;

  const action = matched.args.length === 1 ? matched.args[0].toLowerCase() : undefined;
  if (action === "boost" || action === "private" || action === "full") {
    return { command: matched.command, action };
  }
  return { command: matched.command };
}

function formatSandboxCommandSummary(title: string, lines: string[]): string {
  return formatCommandSummary(title, lines);
}

export class SandboxCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseSandboxCommand(context.commandText);
    if (!parsed) return false;

    if (context.services.sandbox.type !== "image" || !context.services.provisioner) {
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatSandboxCommandSummary("Sandbox", [
          "`/pi-sandbox` 目前只支援 `image:*` managed sandbox。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const containerKey = resolveActorVaultKey(
      context.services.sandbox,
      context.platformUserId,
      context.conversationId,
    );

    if (parsed.action === "private" || parsed.action === "full") {
      updateConversationSettings(join(context.services.workingDir, context.conversationId), {
        sandboxImageWorkspaceMount: parsed.action,
      });
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatSandboxCommandSummary("Sandbox Workspace", [
          parsed.action === "full"
            ? "已將此 conversation 的 sandbox 設為 full workspace mode。"
            : "已將此 conversation 的 sandbox 設為 private workspace mode。",
          `Workspace mount: ${parsed.action}`,
          parsed.action === "full"
            ? "之後這個 container 會把整個 host workspace 掛到 /workspace。"
            : "之後這個 container 只會掛載 private workspace 檔案與當前 conversation 目錄。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (parsed.action === "boost") {
      const boostLimits = context.services.provisioner.getBoostLimits();
      if (!boostLimits?.cpus && !boostLimits?.memory) {
        await replyDiagnosticWithContext(
          context.responseCtx,
          formatSandboxCommandSummary("Sandbox Boost", [
            "此 mikan instance 尚未設定 sandbox boost 規格。",
            "請先在全域 settings.json 設定 `sandbox.boost`。",
          ]),
          { style: "muted" },
        );
        return true;
      }

      const status = await context.services.provisioner.boost(containerKey);
      await replyDiagnosticWithContext(
        context.responseCtx,
        formatSandboxCommandSummary("Sandbox Boost", [
          "已暫時提升此 conversation 的 sandbox 規格。",
          `Current: ${formatLimits(status.limits)}`,
          "boost 會在此 sandbox container 關閉後結束。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const status = context.services.provisioner.getLimitStatus(containerKey);
    const defaultLimits = context.services.provisioner.getDefaultLimits();
    const boostLimits = context.services.provisioner.getBoostLimits();
    const workspaceMount = readConversationWorkspaceMountMode(
      context.services.workingDir,
      context.conversationId,
    );
    await replyDiagnosticWithContext(
      context.responseCtx,
      formatSandboxCommandSummary(
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
