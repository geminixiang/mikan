import { slashForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replySummary } from "./utils.js";
import { errorMessage } from "../../unknown-values.js";

const COMPACT_COMMANDS = slashForms("compact");
const TITLE = "Compact";

export class CompactCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const matched = matchCommand(context.commandText, COMPACT_COMMANDS);
    if (!matched) return false;

    if (!context.services.runtime) {
      await replySummary(context, TITLE, ["Compact is not configured correctly on the server."]);
      return true;
    }

    const instructions = matched.args.join(" ").trim() || undefined;
    try {
      const outcome = await context.services.runtime.handleCompactCommand({
        address: context.address,
        sessionKey: context.sessionKey,
        platform: context.messagingInfo,
        instructions,
      });
      await replySummary(
        context,
        TITLE,
        outcome.compacted
          ? [
              `Context compacted: about ${outcome.tokensBefore.toLocaleString("en-US")} → ${outcome.tokensAfter.toLocaleString("en-US")} tokens.`,
              "Earlier messages stay in the session history.",
            ]
          : ["Nothing to compact yet; the conversation is still short."],
      );
    } catch (error) {
      await replySummary(context, TITLE, [`Could not compact: ${errorMessage(error)}`]);
    }
    return true;
  }
}
