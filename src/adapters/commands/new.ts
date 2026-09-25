import { createConversationMessage } from "../../office/index.js";
import { slashForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replySummary } from "./utils.js";

const NEW_COMMANDS = slashForms("new");

export class NewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, NEW_COMMANDS)) return false;

    if (!context.privateConversation) {
      await replySummary(context, "New Session", [
        "為了避免誤清除共享上下文，`/new` 目前只能在與機器人的私訊 / DM 中使用。",
      ]);
      return true;
    }

    if (!context.services.runtime) {
      await replySummary(context, "New Session", [
        "New command is not configured correctly on the server.",
        "Please try again later.",
      ]);
      return true;
    }

    await context.services.runtime.handleNewCommand({
      bot: context.bot,
      message: createConversationMessage({
        platform: context.address.platform,
        conversationId: context.address.conversationId,
        address: context.address,
        id: `memory:${context.sessionKey}`,
        sessionKey: context.sessionKey,
        conversationKind: "direct",
        userId: context.platformUserId,
        userName: context.platformUserName,
        text: context.commandText,
      }),
    });
    return true;
  }
}
