import { createConversationMessage } from "../adapter.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

const NEW_COMMANDS = slashForms("new");

export class NewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, NEW_COMMANDS)) return false;

    if (!context.privateConversation) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("New Session", [
          "為了避免誤清除共享上下文，`/new` 目前只能在與機器人的私訊 / DM 中使用。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (!context.services.runtime) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("New Session", [
          "New command is not configured correctly on the server.",
          "Please try again later.",
        ]),
        { style: "muted" },
      );
      return true;
    }

    await context.services.runtime.handleNewCommand({
      sessionKey: context.sessionKey,
      conversationId: context.conversationId,
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
