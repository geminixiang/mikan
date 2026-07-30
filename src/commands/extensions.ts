import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultExtensionDirs, listInstalledExtensions } from "../harness/index.js";
import { effectiveStateDir } from "../cli/arg-grammar.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyDiagnosticWithContext } from "./utils.js";

const EXTENSIONS_COMMANDS = slashForms("extensions");

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

    const dirs = defaultExtensionDirs(context.address, effectiveStateDir());
    const installed = listInstalledExtensions(dirs);

    // A root-level index file means an extension's contents were copied into
    // the scope directory itself; the loader skips it (the slug would
    // degenerate to the scope name). Surface that here, not just in logs.
    const misinstalled = dirs.filter((dir) =>
      ["index.mjs", "index.js"].some((file) => existsSync(join(dir, file))),
    );
    const misinstallLines = misinstalled.map(
      (dir) =>
        `⚠️ \`${dir}/index.mjs\` 位於範圍根目錄，已被忽略 — 請移入具名子目錄（如 \`${dir}/my-ext/\`）。`,
    );

    if (installed.length === 0 && misinstallLines.length === 0) {
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

    const lines = ["_Extensions_", ...misinstallLines];
    for (const info of installed) {
      // info.dir ends in `<scope>/extensions`; the scope is its parent segment
      // (`global` or a conversation id).
      const scope = basename(dirname(info.dir)) === "global" ? "global" : "this conversation";
      const version = info.version ? `@${info.version}` : "";
      const slug = info.slug !== info.name ? ` (slug: ${info.slug})` : "";
      lines.push(`• *${info.name}*${version} — ${scope}${slug}`);
      if (info.description) lines.push(`   ${info.description}`);
      if (info.skillNames.length > 0) lines.push(`   skills: ${info.skillNames.join(", ")}`);
    }
    lines.push("_（安裝/移除後，對話輸入 `/pi-new` 生效）_");

    await replyDiagnosticWithContext(context.responder, lines.join("\n"), { style: "muted" });
    return true;
  }
}
