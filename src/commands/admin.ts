import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyDiagnosticWithContext } from "./utils.js";

const ADMIN_COMMANDS = ["admin", "/admin", "/pi-admin"] as const;

export function parseAdminCommand(text: string): { command: string } | null {
  const matched = matchCommand(text, ADMIN_COMMANDS, { stripMention: true });
  return matched ? { command: matched.command } : null;
}

/**
 * Deliver text only to the user who invoked the command:
 * - DM: just reply (responseCtx is already private).
 * - Slash command in a channel: responseCtx is configured ephemeral by the
 *   Slack adapter (ephemeralChannelId set), so respondDiagnostic stays private.
 * - Other platforms / mention path: fall back to bot.postPrivateDiagnostic or
 *   bot.postPrivate so the token never leaks into the channel.
 */
async function sendAdminReply(context: CommandContext, text: string): Promise<void> {
  if (context.privateConversation) {
    await replyDiagnosticWithContext(context.responseCtx, text, { style: "muted" });
    return;
  }
  if (context.bot.postPrivateDiagnostic) {
    await context.bot.postPrivateDiagnostic(context.conversationId, context.platformUserId, text, {
      style: "muted",
    });
    return;
  }
  if (context.bot.postPrivate) {
    await context.bot.postPrivate(context.conversationId, context.platformUserId, text);
    return;
  }
  await replyDiagnosticWithContext(context.responseCtx, text, { style: "muted" });
}

export class AdminCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!parseAdminCommand(context.commandText)) return false;

    if (!context.services.portalBaseUrl) {
      await sendAdminReply(
        context,
        "Admin portal is not configured. Set `MIKAN_LINK_URL` or `MIKAN_LINK_PORT` on the server.",
      );
      return true;
    }

    const platformUser = context.bot
      .getPlatformInfo()
      .users.find((user) => user.id === context.platformUserId);
    const platformUserName = platformUser?.userName || platformUser?.displayName;

    const token = context.services.adminTokenStore.create({
      platform: context.platform,
      platformUserId: context.platformUserId,
      conversationId: context.conversationId,
      ...(platformUserName ? { platformUserName } : {}),
    });

    const url = `${context.services.portalBaseUrl}/admin?token=${token.token}`;
    await sendAdminReply(context, `Open the admin portal (expires in 30 minutes):\n${url}`);
    return true;
  }
}
