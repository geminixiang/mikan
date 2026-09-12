import { resolveExistingSessionFile } from "../../web/session-view/portal.js";
import { commandForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { portalNotConfiguredLines, replySummaryPrivately } from "./utils.js";

// `session` is the only bare command (manifest `bare: true`), so its grammar
// includes the slash-less spelling alongside the derived slash forms.
const SESSION_VIEW_COMMANDS = commandForms("session");

export class SessionViewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, SESSION_VIEW_COMMANDS)) return false;

    if (!context.privateConversation && !context.bot.postPrivate) {
      await replySummaryPrivately(context, "Session", [
        "為了保護對話內容，`/session` 目前只能在與機器人的私訊 / DM 中使用。",
      ]);
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await replySummaryPrivately(context, "Session", portalNotConfiguredLines("Session viewer"));
      return true;
    }

    const sessionFile = resolveExistingSessionFile(
      context.services.workspace.office(context.address).dir,
      context.sessionKey,
    );
    if (!sessionFile) {
      await replySummaryPrivately(context, "Session", [
        "目前還沒有可查看的 session。",
        "先和機器人對話一次，建立 session 後再試。",
      ]);
      return true;
    }

    const platformUser = context.bot
      .getMessagingInfo()
      .users.find((user) => user.id === context.platformUserId);
    const platformUserName = platformUser?.userName || platformUser?.displayName;

    const token = context.services.sessionViewTokenStore.create({
      platform: context.platform,
      platformUserId: context.platformUserId,
      conversationId: context.conversationId,
      sessionKey: context.sessionKey,
      sessionFile,
      platformUserName,
    });

    await replySummaryPrivately(context, "Session", [
      `${context.services.portalBaseUrl}/session?token=${token.token}`,
      "Expires: 24 hours",
    ]);
    return true;
  }
}
