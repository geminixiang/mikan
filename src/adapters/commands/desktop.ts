import { ActorExecutionResolver } from "../../harness/execution-resolver.js";
import { commandForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { portalNotConfiguredLines, replySummaryPrivately } from "./utils.js";

const DESKTOP_COMMANDS = commandForms("desktop");
const TITLE = "Desktop";

export class DesktopCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    if (!matchCommand(context.commandText, DESKTOP_COMMANDS)) return false;

    const { sandbox, provisioner, desktop, desktopTokenStore, portalBaseUrl } = context.services;
    if (sandbox.type !== "oci" || !provisioner || !desktop) {
      await replySummaryPrivately(context, TITLE, [
        "The desktop runs in a sandbox that mikan manages; start mikan with --sandbox=oci to use it.",
      ]);
      return true;
    }
    if (!portalBaseUrl || !desktopTokenStore) {
      await replySummaryPrivately(context, TITLE, portalNotConfiguredLines("Desktop"));
      return true;
    }

    const resolver = new ActorExecutionResolver(
      sandbox,
      context.services.vaultManager,
      provisioner,
      context.services.workspace,
    );
    const containerKey = await resolver.prepare({
      address: context.address,
      userId: context.platformUserId,
      trustModel: context.messagingInfo.trustModel ?? "membership",
    });
    const started = await desktop.start(containerKey);
    if (started !== "ready") {
      await replySummaryPrivately(context, TITLE, [
        "This conversation's sandbox is still running an older sandbox image without the desktop.",
        "It moves to the current image once it has been idle and stops; ask again after that.",
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
