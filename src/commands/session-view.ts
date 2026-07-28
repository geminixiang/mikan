import { resolveExistingSessionFile } from "../web/session-view/service.js";
import { parseSessionViewCommand } from "../web/session-view/command.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyPrivatelyWithContext } from "./utils.js";
import { conversationOfficeDir } from "../office-address.js";

export class SessionViewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!parseSessionViewCommand(context.commandText)) return false;

    if (!context.privateConversation && !context.bot.postPrivate) {
      await replyPrivatelyWithContext(
        context,
        formatCommandSummary("Session", [
          "為了保護對話內容，`/session` 目前只能在與機器人的私訊 / DM 中使用。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await replyPrivatelyWithContext(
        context,
        formatCommandSummary("Session", [
          "Session viewer is not configured.",
          "Set `MIKAN_LINK_URL` or `MIKAN_LINK_PORT` on the server.",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const sessionFile = resolveExistingSessionFile(
      conversationOfficeDir(context.services.workingDir, context.address),
      context.sessionKey,
    );
    if (!sessionFile) {
      await replyPrivatelyWithContext(
        context,
        formatCommandSummary("Session", [
          "目前還沒有可查看的 session。",
          "先和機器人對話一次，建立 session 後再試。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const platformUser = context.bot
      .getMessagingInfo()
      .users.find((user) => user.id === context.platformUserId);
    const platformUserName = platformUser?.userName || platformUser?.displayName;

    const token = context.services.sessionViewTokenStore.create(
      context.platform,
      context.platformUserId,
      context.conversationId,
      context.sessionKey,
      sessionFile,
      platformUserName,
    );

    await replyPrivatelyWithContext(
      context,
      formatCommandSummary("Session", [
        `${context.services.portalBaseUrl}/session?token=${token.token}`,
        "Expires: 24 hours",
      ]),
      { style: "muted" },
    );
    return true;
  }
}
