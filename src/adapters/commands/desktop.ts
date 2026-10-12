import { commandForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { portalNotConfiguredLines, replySummaryPrivately } from "./utils.js";

const DESKTOP_COMMANDS = commandForms("desktop");
const TITLE = "Desktop";

export class DesktopCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, DESKTOP_COMMANDS)) return false;

    if (
      !context.privateConversation &&
      !context.bot.postPrivate &&
      !context.bot.postPrivateDiagnostic
    ) {
      await replySummaryPrivately(context, TITLE, [
        "A desktop link gives full use of this conversation's sandbox, so it is sent only privately. Ask for it in a direct message with the bot.",
      ]);
      return true;
    }

    const { sandbox, openDesktop, desktopTokenStore, portalBaseUrl } = context.services;
    if (sandbox.type !== "oci" || !openDesktop) {
      await replySummaryPrivately(context, TITLE, [
        "The desktop runs in a sandbox that mikan manages; start mikan with --sandbox=oci to use it.",
      ]);
      return true;
    }
    if (!portalBaseUrl || !desktopTokenStore) {
      await replySummaryPrivately(context, TITLE, portalNotConfiguredLines("Desktop"));
      return true;
    }

    const started = await openDesktop({
      address: context.address,
      userId: context.platformUserId,
      trustModel: context.messagingInfo.trustModel,
    });
    if (started === "outdated-image") {
      await replySummaryPrivately(context, TITLE, [
        "This conversation's sandbox is still running an older sandbox image without the desktop.",
        "It moves to the current image once it has been idle and stops; ask again after that.",
      ]);
      return true;
    }
    if (started === "stopped") {
      await replySummaryPrivately(context, TITLE, [
        "This conversation's sandbox could not start. Try again, or ask the operator to check it.",
      ]);
      return true;
    }

    const { token } = desktopTokenStore.create({
      platform: context.platform,
      platformUserId: context.platformUserId,
      office: context.services.workspace.office(context.address),
    });
    await replySummaryPrivately(context, TITLE, [
      `${portalBaseUrl}/desktop?token=${token}`,
      "Expires: 24 hours",
    ]);
    return true;
  }
}
