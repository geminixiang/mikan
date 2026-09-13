import { slashForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { portalNotConfiguredLines, replySummary, replySummaryPrivately } from "./utils.js";

const ADMIN_COMMANDS = slashForms("admin");

export class AdminCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, ADMIN_COMMANDS, { stripMention: true })) return false;

    if (!context.privateConversation && !context.bot.postPrivate) {
      await replySummary(context, "Admin", [
        "For privacy, open a direct conversation with mikan and run `/admin` there.",
      ]);
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await replySummaryPrivately(context, "Admin", portalNotConfiguredLines("Admin portal"));
      return true;
    }

    const platformUser = context.bot
      .getMessagingInfo()
      .users.find((user) => user.id === context.platformUserId);
    const platformUserName = platformUser?.userName || platformUser?.displayName;

    const token = context.services.adminTokenStore.create({
      platform: context.platform,
      platformUserId: context.platformUserId,
      conversationId: context.conversationId,
      ...(platformUserName ? { platformUserName } : {}),
    });

    const url = `${context.services.portalBaseUrl}/admin?token=${token.token}`;
    await replySummaryPrivately(context, "Admin", [url, "Expires: 30 minutes"]);
    return true;
  }
}
