import { resolveWorkspaceProjection } from "../../office/projection.js";
import { runtimeResourceKey } from "../../sandbox/identity.js";
import { applyOfficeVisibility } from "../../settings/apply.js";
import { slashForms, matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler, ParsedSandboxCommand } from "./types.js";
import { replySummary } from "./utils.js";

export type { ParsedSandboxCommand } from "./types.js";

const SANDBOX_COMMANDS = slashForms("sandbox");

export function parseSandboxCommand(text: string): ParsedSandboxCommand | null {
  const matched = matchCommand(text, SANDBOX_COMMANDS, { stripMention: true });
  if (!matched) return null;

  const action = matched.args[0]?.toLowerCase();
  if (action === "boost" && matched.args.length === 1) {
    return { action };
  }
  if (action === "visibility" && matched.args.length <= 2) {
    return {
      action,
      ...(matched.args.length === 2 ? { visibility: matched.args[1]?.toLowerCase() } : {}),
    };
  }
  return {};
}

export class SandboxCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseSandboxCommand(context.commandText);
    if (!parsed) return false;

    if (context.services.sandbox.type !== "image" || !context.services.resourceController) {
      await replySummary(context, "Sandbox", [
        "`/pi-sandbox` 目前只支援 `image:*` managed sandbox。",
      ]);
      return true;
    }

    const controller = context.services.resourceController;
    const containerKey = runtimeResourceKey(context.services.sandbox, {
      userId: context.platformUserId,
      address: context.address,
    });
    if (parsed.action === "boost") {
      await handleBoost(context, controller, containerKey);
    } else if (parsed.action === "visibility") {
      await handleVisibility(context, parsed);
    } else {
      await showSandboxStatus(context, controller, containerKey);
    }
    return true;
  }
}

async function handleBoost(
  context: CommandContext,
  controller: NonNullable<CommandContext["services"]["resourceController"]>,
  containerKey: string,
): Promise<void> {
  const boostLimits = controller.getBoostLimits();
  if (!boostLimits?.cpus && !boostLimits?.memory) {
    await replySummary(context, "Sandbox Boost", [
      "此 mikan instance 尚未設定 sandbox boost 規格。",
      "請先在全域 settings.json 設定 `sandbox.boost`。",
    ]);
    return;
  }

  const status = await controller.boost(containerKey);
  await replySummary(context, "Sandbox Boost", [
    "已暫時提升此 conversation 的 sandbox 規格。",
    `Current: ${formatLimits(status.limits)}`,
    "boost 會在此 sandbox runtime 關閉後結束。",
  ]);
}

function describeVisibility(projection: ReturnType<typeof resolveWorkspaceProjection>): string {
  const source =
    projection.source === "override"
      ? "admin 覆寫"
      : projection.source === "platform"
        ? "依平台頻道類型"
        : "Slack 尚未回報頻道類型，預設 private";
  return `${projection.visibility}（${source}）`;
}

async function handleVisibility(
  context: CommandContext,
  parsed: ParsedSandboxCommand,
): Promise<void> {
  const office = context.services.workspace.office(context.address);
  const projection = resolveWorkspaceProjection(office);
  if (parsed.visibility === undefined) {
    await replySummary(context, "Office Visibility", [
      `Current: ${describeVisibility(projection)}`,
      "",
      "public：其他 office 可唯讀這個 office，且可寫入共用 MEMORY.md / skills。",
      "private：只有自己看得到，共用 MEMORY.md / skills 唯讀。",
      "預設跟隨 Slack 頻道類型；private 頻道與 DM 一律 private。",
      "admin 覆寫：`/pi-sandbox visibility <private|default>`（只能把 public 頻道改為 private）",
    ]);
    return;
  }
  if (parsed.visibility !== "private" && parsed.visibility !== "default") {
    await replySummary(context, "Office Visibility", [
      `未知的值：\`${parsed.visibility}\`。可用值：\`private\`、\`default\``,
    ]);
    return;
  }
  const result = applyOfficeVisibility(
    context.services.runtime,
    office,
    parsed.visibility === "private" ? "private" : null,
  );
  if (!result.ok) {
    await replySummary(context, "Office Visibility", [
      "目前有工作正在執行，無法切換 visibility。等執行結束後再試一次。",
    ]);
    return;
  }
  const updated = resolveWorkspaceProjection(office);
  await replySummary(context, "Office Visibility", [
    `Visibility 已更新。Current: ${describeVisibility(updated)}`,
    "下一則訊息時會以新的掛載重建 sandbox 容器；容器內容會保留。",
  ]);
}

async function showSandboxStatus(
  context: CommandContext,
  controller: NonNullable<CommandContext["services"]["resourceController"]>,
  containerKey: string,
): Promise<void> {
  const status = controller.getLimitStatus(containerKey);
  const defaultLimits = controller.getDefaultLimits();
  const boostLimits = controller.getBoostLimits();
  const projection = resolveWorkspaceProjection(context.services.workspace.office(context.address));
  await replySummary(
    context,
    "Sandbox",
    [
      `Current: ${formatLimits(status.limits)}`,
      `Status: ${status.boosted ? "boosted" : "default"}`,
      `Office visibility: ${describeVisibility(projection)}`,
      "",
      `Default: ${formatLimits(defaultLimits)}`,
      boostLimits ? `Boost: ${formatLimits({ ...defaultLimits, ...boostLimits })}` : undefined,
    ].filter((line): line is string => line !== undefined),
  );
}

function formatLimits(limits: { cpus?: string; memory?: string } | undefined): string {
  return `CPU ${limits?.cpus ?? "unlimited"} / Memory ${limits?.memory ?? "unlimited"}`;
}
