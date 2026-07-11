import { basename } from "node:path";
import { defaultExtensionDirs, listInstalledExtensions } from "../harness/index.js";
import { readEnv } from "../utils/env.js";
import { matchCommand } from "./parse.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyDiagnosticWithContext } from "./utils.js";

const EXTENSIONS_COMMANDS = ["/pi-extensions", "/extensions"] as const;

/**
 * `/pi-extensions` — inventory of extensions installed for this conversation.
 *
 * Discovery-only (nothing is imported or activated): it reports what is on
 * disk under the host-only state dir, for both the `global` scope and this
 * conversation's scope. Doubles as the user-facing answer to "why can the
 * bot suddenly do X" and the operator-facing answer to "what is installed
 * where".
 */
export class ExtensionsCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const matched = matchCommand(context.commandText, EXTENSIONS_COMMANDS, { stripMention: true });
    if (!matched) return false;

    const dirs = defaultExtensionDirs(context.conversationId, readEnv("STATE_DIR"));
    const installed = listInstalledExtensions(dirs);

    if (installed.length === 0) {
      await replyDiagnosticWithContext(
        context.responder,
        [
          "_Extensions_",
          "沒有安裝任何 extension。",
          `安裝位置：\`${dirs[0]}\`（所有會話）或 \`${dirs[1]}\`（僅此會話）。`,
        ].join("\n"),
        { style: "muted" },
      );
      return true;
    }

    const lines = ["_Extensions_"];
    for (const info of installed) {
      const scope = basename(info.dir) === "global" ? "global" : "this conversation";
      const version = info.version ? `@${info.version}` : "";
      lines.push(`• *${info.name}*${version} — ${scope}`);
      if (info.description) lines.push(`   ${info.description}`);
      if (info.skillNames.length > 0) lines.push(`   skills: ${info.skillNames.join(", ")}`);
    }
    lines.push("_（安裝/移除後，對話輸入 `/pi-new` 生效）_");

    await replyDiagnosticWithContext(context.responder, lines.join("\n"), { style: "muted" });
    return true;
  }
}
