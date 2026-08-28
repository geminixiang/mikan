import type { WorkspacePolicyChoice } from "../config.js";
import { resolveWorkspaceProjection } from "../workspace-projection/index.js";
import { runtimeResourceKey } from "../sandbox/identity.js";
import { applyConversationWorkspacePolicy } from "../settings-mutation.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler, ParsedSandboxCommand } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

/**
 * Word → selection; null clears the override, undefined is an unknown word.
 * `shared`/`shared-support` default to public visibility (today's read-write
 * behavior, unchanged); `shared-private` reads workspace memory but cannot
 * write it, so information can flow in without leaking back out.
 */
function doorChoiceFromWord(word: string): WorkspacePolicyChoice | null | undefined {
  switch (word) {
    case "default":
      return null;
    case "isolated":
      return { doorPolicy: "isolated" };
    case "shared":
    case "shared-support":
    case "shared-public":
      return { doorPolicy: "trusted", layout: "shared-support", visibility: "public" };
    case "shared-private":
      return { doorPolicy: "trusted", layout: "shared-support", visibility: "private" };
    case "full":
      return { doorPolicy: "trusted", layout: "full" };
    default:
      return undefined;
  }
}

export type { ParsedSandboxCommand } from "./types.js";

const SANDBOX_COMMANDS = slashForms("sandbox");

export function parseSandboxCommand(text: string): ParsedSandboxCommand | null {
  const matched = matchCommand(text, SANDBOX_COMMANDS, { stripMention: true });
  if (!matched) return null;

  const action = matched.args[0]?.toLowerCase();
  if (action === "boost" && matched.args.length === 1) {
    return { action };
  }
  if (action === "door" && matched.args.length <= 2) {
    return {
      action,
      ...(matched.args.length === 2 ? { doorPolicy: matched.args[1]?.toLowerCase() } : {}),
    };
  }
  return {};
}

export class SandboxCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseSandboxCommand(context.commandText);
    if (!parsed) return false;

    if (
      (context.services.sandbox.type !== "image" && context.services.sandbox.type !== "gondolin") ||
      !context.services.resourceController
    ) {
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Sandbox", [
          "`/pi-sandbox` 目前只支援 `image:*` 與 `gondolin:*` managed sandbox。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const containerKey = runtimeResourceKey(context.services.sandbox, {
      userId: context.platformUserId,
      address: context.address,
    });

    if (parsed.action === "boost") {
      const boostLimits = context.services.resourceController.getBoostLimits();
      if (!boostLimits?.cpus && !boostLimits?.memory) {
        await replyDiagnosticWithContext(
          context.responder,
          formatCommandSummary("Sandbox Boost", [
            "此 mikan instance 尚未設定 sandbox boost 規格。",
            "請先在全域 settings.json 設定 `sandbox.boost`。",
          ]),
          { style: "muted" },
        );
        return true;
      }

      const status = await context.services.resourceController.boost(containerKey);
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Sandbox Boost", [
          "已暫時提升此 conversation 的 sandbox 規格。",
          `Current: ${formatLimits(status.limits)}`,
          "boost 會在此 sandbox runtime 關閉後結束。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    if (parsed.action === "door") {
      const projection = resolveWorkspaceProjection(
        context.services.workspace.office(context.address),
      );
      if (parsed.doorPolicy === undefined) {
        await replyDiagnosticWithContext(
          context.responder,
          formatCommandSummary("Sandbox Door", [
            `Current: ${projection.doorPolicy} / ${projection.layout} / ${projection.visibility}`,
            "",
            "用法：`/pi-sandbox door <default|isolated|shared|shared-private|full>`",
            "- `default`：跟隨全域預設",
            "- `isolated`：只掛載自己辦公室",
            "- `shared`：辦公室 + 共用 MEMORY.md / skills / events（可讀寫）",
            "- `shared-private`：同 shared，但共用 MEMORY.md 只讀不可寫（避免資訊外流）",
            "- `full`：掛載整個 workspace（全開）",
          ]),
          { style: "muted" },
        );
        return true;
      }
      const choice = doorChoiceFromWord(parsed.doorPolicy);
      if (choice === undefined) {
        await replyDiagnosticWithContext(
          context.responder,
          formatCommandSummary("Sandbox Door", [
            `未知的 door policy：\`${parsed.doorPolicy}\``,
            "可用值：`default`、`isolated`、`shared`、`shared-private`、`full`",
          ]),
          { style: "muted" },
        );
        return true;
      }
      const result = applyConversationWorkspacePolicy(
        context.services.runtime,
        context.services.workspace.office(context.address),
        choice,
      );
      if (!result.ok) {
        await replyDiagnosticWithContext(
          context.responder,
          formatCommandSummary("Sandbox Door", [
            "目前有工作正在執行，無法切換 door policy。等執行結束後再試一次。",
          ]),
          { style: "muted" },
        );
        return true;
      }
      const updated = resolveWorkspaceProjection(
        context.services.workspace.office(context.address),
      );
      await replyDiagnosticWithContext(
        context.responder,
        formatCommandSummary("Sandbox Door", [
          `Door policy 已更新。Effective: ${updated.doorPolicy} / ${updated.layout} / ${updated.visibility}`,
          "下一則訊息時會以新的掛載重建 sandbox 容器；容器內容會保留。",
        ]),
        { style: "muted" },
      );
      return true;
    }

    const status = context.services.resourceController.getLimitStatus(containerKey);
    const defaultLimits = context.services.resourceController.getDefaultLimits();
    const boostLimits = context.services.resourceController.getBoostLimits();
    const projection = resolveWorkspaceProjection(
      context.services.workspace.office(context.address),
    );
    await replyDiagnosticWithContext(
      context.responder,
      formatCommandSummary(
        "Sandbox",
        [
          `Current: ${formatLimits(status.limits)}`,
          `Status: ${status.boosted ? "boosted" : "default"}`,
          `Workspace policy: ${projection.doorPolicy}`,
          `Workspace layout: ${projection.layout}`,
          `Workspace visibility: ${projection.visibility}`,
          "",
          `Default: ${formatLimits(defaultLimits)}`,
          boostLimits ? `Boost: ${formatLimits({ ...defaultLimits, ...boostLimits })}` : undefined,
        ].filter((line): line is string => line !== undefined),
      ),
      { style: "muted" },
    );
    return true;
  }
}

function formatLimits(limits: { cpus?: string; memory?: string } | undefined): string {
  return `CPU ${limits?.cpus ?? "unlimited"} / Memory ${limits?.memory ?? "unlimited"}`;
}
