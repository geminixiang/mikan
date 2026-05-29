import { resolveExistingSessionFile } from "../session-view/service.js";
import { parseSessionViewCommand } from "../session-view/command.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

export class SessionViewCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!parseSessionViewCommand(context.commandText)) return false;

    const sendSessionViewReply = async (lines: string[]): Promise<void> => {
      const text = formatCommandSummary("Session", lines);
      if (context.privateConversation) {
        await replyDiagnosticWithContext(context.responseCtx, text, { style: "muted" });
        return;
      }

      if (context.bot.postPrivateDiagnostic) {
        await context.bot.postPrivateDiagnostic(
          context.conversationId,
          context.platformUserId,
          text,
          {
            style: "muted",
          },
        );
        return;
      }

      if (context.bot.postPrivate) {
        await context.bot.postPrivate(context.conversationId, context.platformUserId, text);
        return;
      }

      await replyDiagnosticWithContext(context.responseCtx, text, { style: "muted" });
    };

    if (!context.privateConversation && !context.bot.postPrivate) {
      await sendSessionViewReply([
        "為了保護對話內容，`/session` 目前只能在與機器人的私訊 / DM 中使用。",
      ]);
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await sendSessionViewReply([
        "Session viewer is not configured.",
        "Set `MIKAN_LINK_URL` or `MIKAN_LINK_PORT` on the server.",
      ]);
      return true;
    }

    const sessionFile = resolveExistingSessionFile(
      context.services.workingDir,
      context.conversationId,
      context.sessionKey,
    );
    if (!sessionFile) {
      await sendSessionViewReply([
        "目前還沒有可查看的 session。",
        "先和機器人對話一次，建立 session 後再試。",
      ]);
      return true;
    }

    const platformUser = context.bot
      .getPlatformInfo()
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

    await sendSessionViewReply([
      `${context.services.portalBaseUrl}/session?token=${token.token}`,
      "Expires: 24 hours",
    ]);
    return true;
  }
}
