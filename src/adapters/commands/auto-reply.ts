import {
  setSlackConversationAutoReply,
  slackConversationAutoReplyMode,
  type SlackAutoReplyMode,
} from "../../settings/index.js";
import { slashForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replySummary } from "./utils.js";

const AUTO_REPLY_COMMANDS = slashForms("autoreply");

function isAutoReplyMode(value: string | undefined): value is SlackAutoReplyMode {
  return value === "on" || value === "off" || value === "jev";
}

function describeAutoReplyMode(mode: SlackAutoReplyMode): string {
  switch (mode) {
    case "on":
      return "Enabled. New messages in this channel will trigger mikan without a mention.";
    case "jev":
      return "Jev-assisted. Jev decides per message whether it addresses mikan.";
    case "off":
      return "Disabled. New messages in this channel must address mikan explicitly.";
  }
}

export class AutoReplyCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const matched = matchCommand(context.commandText, AUTO_REPLY_COMMANDS);
    if (!matched) return false;

    if (context.platform !== "slack") {
      await replySummary(context, "Auto-reply", [
        "Auto-reply is currently available on Slack only.",
      ]);
      return true;
    }

    if (context.privateConversation) {
      await replySummary(context, "Auto-reply", [
        "Auto-reply only applies to shared channels. Direct messages already reply automatically.",
      ]);
      return true;
    }

    const value = matched.args[0]?.toLowerCase();
    if (!isAutoReplyMode(value) || matched.args.length !== 1) {
      await replySummary(context, "Auto-reply", ["Usage: `/pi-auto-reply <on|off|jev>`"]);
      return true;
    }

    const office = context.services.workspace.office(context.address);
    setSlackConversationAutoReply(office, value);
    const mode = slackConversationAutoReplyMode(office);
    await replySummary(context, "Auto-reply", [describeAutoReplyMode(mode)]);
    return true;
  }
}
