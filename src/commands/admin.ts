import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyPrivatelyWithContext } from "./utils.js";

const ADMIN_COMMANDS = slashForms("admin");

export class AdminCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, ADMIN_COMMANDS, { stripMention: true })) return false;

    if (!context.services.portalBaseUrl) {
      await replyPrivatelyWithContext(
        context,
        formatCommandSummary("Admin", [
          "Admin portal is not configured.",
          "Set `MIKAN_LINK_URL` or `MIKAN_LINK_PORT` on the server.",
        ]),
        { style: "muted" },
      );
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
    await replyPrivatelyWithContext(
      context,
      formatCommandSummary("Admin", [url, "Expires: 30 minutes"]),
      { style: "muted" },
    );
    return true;
  }
}
