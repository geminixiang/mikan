import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaultExtensionDirs, listInstalledExtensions } from "../harness/index.js";
import { effectiveStateDir } from "../cli/arg-grammar.js";
import { inspectConversationPackages } from "../packages/index.js";
import type { PackageStatus } from "../packages/types.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { replyDiagnosticWithContext } from "./utils.js";

const EXTENSIONS_COMMANDS = slashForms("extensions");

/**
 * `/pi-extensions` — inventory of extensions available to this conversation.
 *
 * Covers **both** ways an extension arrives, because they land in different
 * places and reporting only one is actively misleading: `mikan ext install`
 * copies into the scope's `extensions/` directory, while a package declared in
 * the admin portal is a git checkout under `<scope>/git/`. Listing only the
 * former made a portal-installed extension look like it had not been installed
 * at all, which is a worse answer than saying nothing.
 *
 * Discovery-only for the copied form (nothing is imported or activated).
 * Package inspection resolves offline — a chat command never reaches the
 * network — so a package whose checkout is missing is reported as an error
 * rather than silently fetched.
 */
export class ExtensionsCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const matched = matchCommand(context.commandText, EXTENSIONS_COMMANDS, { stripMention: true });
    if (!matched) return false;

    const dirs = defaultExtensionDirs(context.address, effectiveStateDir());
    const installed = listInstalledExtensions(dirs);
    const packages = await this.readPackages(context);

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

    if (installed.length === 0 && packages.length === 0 && misinstallLines.length === 0) {
      await replyDiagnosticWithContext(
        context.responder,
        [
          "_Extensions_",
          "沒有安裝任何 extension。",
          `CLI 安裝位置：\`${dirs[0]}\`（所有會話）或 \`${dirs[1]}\`（僅此會話）。`,
          "或在 `/pi-admin` 的 Extensions 面板加入 git 套件。",
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

    for (const entry of packages) {
      lines.push(...describePackage(entry));
    }

    lines.push("_（安裝/移除後，對話輸入 `/pi-new` 生效）_");

    await replyDiagnosticWithContext(context.responder, lines.join("\n"), { style: "muted" });
    return true;
  }

  /**
   * Declared packages for both scopes. Never throws: an unreadable package
   * list must not take the whole inventory down, since the copied extensions
   * above are still worth reporting.
   */
  private async readPackages(context: CommandContext): Promise<PackageStatus[]> {
    try {
      const inventory = await inspectConversationPackages({
        office: context.services.workspace.office(context.address),
      });
      return [...inventory.global, ...inventory.conversation];
    } catch {
      return [];
    }
  }
}

/** One package's lines: what it provides, or why it provides nothing. */
function describePackage(entry: PackageStatus): string[] {
  const scope = entry.scope === "global" ? "global" : "this conversation";
  const provides = [
    ...entry.extensions.map((slug) => `ext: ${slug}`),
    ...entry.skills.map((name) => `skill: ${name}`),
  ];
  const lines = [`• \`${entry.source}\` — package, ${scope}`];

  if (entry.error) {
    lines.push(`   ⚠️ ${entry.error}`);
    return lines;
  }
  if (entry.shadowed) {
    lines.push("   被此對話的同名套件覆蓋，不會載入");
    return lines;
  }
  lines.push(
    provides.length > 0 ? `   ${provides.join(" · ")}` : "   此套件沒有提供 extension 或 skill",
  );
  return lines;
}
