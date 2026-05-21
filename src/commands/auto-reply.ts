import { join } from "path";
import {
  type AutoReplyConfig,
  loadConversationAutoReplyConfig,
  saveConversationAutoReplyConfig,
} from "../config.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyDiagnosticWithContext } from "./utils.js";

type AutoReplyAction = { type: "status" } | { type: "on" } | { type: "off" } | { type: "invalid" };

export function parseAutoReplyCommand(text: string): AutoReplyAction | null {
  const trimmed = text.trim().replace(/@\w+$/i, "");
  const match = /^(?:(?:\/)?auto-?reply|\/pi-auto-?reply)(?:\s+(.*))?$/i.exec(trimmed);
  if (!match) return null;

  const rest = match[1]?.trim();
  if (!rest) return { type: "status" };

  const lower = rest.toLowerCase();
  if (lower === "status") return { type: "status" };
  if (lower === "on" || lower === "enable" || lower === "enabled") return { type: "on" };
  if (lower === "off" || lower === "disable" || lower === "disabled") return { type: "off" };

  return { type: "invalid" };
}

function formatAutoReplyStatus(config: AutoReplyConfig): string {
  const status = `_Auto-reply is ${config.enabled ? "enabled" : "disabled"} for this channel._`;
  if (config.rules.length === 0) return status;

  return `${status}\nCurrent rules:\n\`\`\`\n${config.rules.join("\n")}\n\`\`\``;
}

function formatAutoReplyUsage(): string {
  return "_Usage: `/pi-auto-reply on|off|status`_";
}

function applyAction(current: AutoReplyConfig, action: AutoReplyAction): AutoReplyConfig {
  switch (action.type) {
    case "status":
    case "invalid":
      return current;
    case "on":
      return { ...current, enabled: true };
    case "off":
      return { ...current, enabled: false };
  }
}

export class AutoReplyCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const action = parseAutoReplyCommand(context.commandText);
    if (!action) return false;

    if (context.privateConversation) {
      await replyDiagnosticWithContext(
        context.responseCtx,
        "_Auto Reply_\n只能在 group/channel 裡設定。",
        { style: "muted" },
      );
      return true;
    }

    if (action.type === "invalid") {
      await replyDiagnosticWithContext(context.responseCtx, formatAutoReplyUsage(), {
        style: "muted",
      });
      return true;
    }

    const conversationDir = join(context.services.workingDir, context.conversationId);
    const current = loadConversationAutoReplyConfig(conversationDir);
    const next = applyAction(current, action);
    if (action.type === "on" || (action.type === "off" && current.enabled)) {
      saveConversationAutoReplyConfig(conversationDir, next);
    }

    const status = formatAutoReplyStatus(next);
    const text =
      action.type === "on"
        ? `${status}\nEdit rules at: \`${join(conversationDir, "auto-reply")}\``
        : status;
    await replyDiagnosticWithContext(context.responseCtx, text, {
      style: "muted",
    });
    return true;
  }
}
