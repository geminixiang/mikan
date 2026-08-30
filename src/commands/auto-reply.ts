import { join } from "node:path";
import {
  type AutoReplyConfig,
  loadConversationAutoReplyConfig,
  saveConversationAutoReplyConfig,
} from "../config.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

type AutoReplyAction = { type: "status" } | { type: "on" } | { type: "off" } | { type: "invalid" };

const AUTO_REPLY_COMMANDS = slashForms("auto-reply");

function parseAutoReplyCommand(text: string): AutoReplyAction | null {
  const matched = matchCommand(text, AUTO_REPLY_COMMANDS, { stripMention: true });
  if (!matched) return null;
  if (matched.args.length === 0) return { type: "status" };

  const lower = matched.args.join(" ").toLowerCase();
  if (lower === "status") return { type: "status" };
  if (lower === "on" || lower === "enable" || lower === "enabled") return { type: "on" };
  if (lower === "off" || lower === "disable" || lower === "disabled") return { type: "off" };

  return { type: "invalid" };
}

function formatAutoReplyStatus(config: AutoReplyConfig): string {
  const lines = [`Auto-reply is ${config.enabled ? "enabled" : "disabled"} for this channel.`];
  if (config.rules.length > 0) {
    lines.push(`Current rules: ${config.rules.join("; ")}`);
  }
  return formatCommandSummary("Auto Reply", lines);
}

/**
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export class AutoReplyCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const action = parseAutoReplyCommand(context.commandText);
    if (!action) return false;

    if (context.privateConversation) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Auto Reply", ["只能在 group/channel 裡設定。"]),
        { style: "muted" },
      );
      return true;
    }

    if (action.type === "invalid") {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Auto Reply", ["Usage: `/pi-auto-reply on|off|status`"]),
        { style: "muted" },
      );
      return true;
    }

    const conversationDir = context.services.workspace.office(context.address).dir;
    const current = loadConversationAutoReplyConfig(conversationDir);
    let next = current;
    if (action.type === "on") next = { ...current, enabled: true };
    else if (action.type === "off") next = { ...current, enabled: false };
    if (action.type === "on" || (action.type === "off" && current.enabled)) {
      saveConversationAutoReplyConfig(conversationDir, next);
    }

    const status = formatAutoReplyStatus(next);
    const text =
      action.type === "on"
        ? `${status}\nEdit rules at: \`${join(conversationDir, "auto-reply")}\``
        : status;
    await replyDiagnosticWithContext(context.responder, text, {
      style: "muted",
    });
    return true;
  }
}
