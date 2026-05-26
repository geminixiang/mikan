import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyWithContext } from "./utils.js";

type ParsedNewCommand = {
  command: "new" | "/new" | "/pi-new";
};

const NEW_COMMANDS = ["new", "/new", "/pi-new"] as const;

function parseNewCommand(text: string): ParsedNewCommand | null {
  const matched = matchCommand(text, NEW_COMMANDS);
  return matched ? { command: matched.command } : null;
}

export class NewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!parseNewCommand(context.commandText)) return false;

    if (!context.privateConversation) {
      await replyWithContext(
        context.responseCtx,
        "為了避免誤清除共享上下文，`/new` 目前只能在與機器人的私訊 / DM 中使用。",
      );
      return true;
    }

    if (!context.services.runtime) {
      await replyWithContext(
        context.responseCtx,
        "New command is not configured correctly on the server. Please try again later.",
      );
      return true;
    }

    await context.services.runtime.handleNewCommand(
      context.sessionKey,
      context.conversationId,
      context.bot,
    );
    return true;
  }
}
