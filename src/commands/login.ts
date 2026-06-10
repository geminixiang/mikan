import * as log from "../log.js";
import { parseLoginCommand } from "../web/login/oauth.js";
import { resolveActorScopeKey } from "../sandbox/index.js";
import { sharedVaultKey } from "../vault/index.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { formatCommandSummary, replyDiagnosticWithContext } from "./utils.js";

function ensureLoginVault(context: CommandContext): string {
  const { services, platformUserId, conversationId, vaultConversationId } = context;
  return resolveActorScopeKey(
    services.sandbox,
    platformUserId,
    vaultConversationId ?? conversationId,
  );
}

async function replyVault(context: CommandContext, lines: string[]): Promise<void> {
  await replyDiagnosticWithContext(context.responseCtx, formatCommandSummary("Vault", lines), {
    style: "muted",
  });
}

async function refreshCopiedVaultRuntime(
  context: CommandContext,
  vaultId: string,
): Promise<string | undefined> {
  if (context.services.sandbox.type !== "image") return undefined;

  const targetConversationId = context.vaultConversationId ?? context.conversationId;
  const cleared = context.services.runtime?.refreshConversationEnvironment(targetConversationId);
  if (cleared === false) {
    return "A session is currently running, so the sandbox was not restarted. The copied credentials will be applied after the run finishes and the sandbox is recreated.";
  }

  if (!context.services.provisioner) {
    return "The cached session was refreshed. The sandbox will pick up copied credentials on the next provision.";
  }

  await context.services.provisioner.remove(vaultId);
  return "The sandbox container was removed and will be recreated with the copied env and file mounts on the next message.";
}

export class LoginCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseLoginCommand(context.commandText);
    if (!parsed) return false;

    if (!context.privateConversation) {
      await replyVault(context, [
        "為了保護你的憑證，`/login` 只能在與機器人的私訊中使用。",
        "請先私訊機器人，再重新執行 `/login`。",
      ]);
      return true;
    }

    if (parsed.action === "shared_list") {
      const profiles = context.services.vaultManager.listSharedVaults();
      await replyVault(
        context,
        profiles.length > 0
          ? ["Shared login profiles:", ...profiles.map((name) => `- ${name}`)]
          : ["No shared login profiles found."],
      );
      return true;
    }

    if (parsed.action === "shared_delete") {
      try {
        const deleted = context.services.vaultManager.deleteSharedVault(parsed.name);
        await replyVault(context, [
          deleted
            ? `Deleted shared login profile \`${parsed.name}\`.`
            : `Shared login profile \`${parsed.name}\` does not exist.`,
        ]);
      } catch (error) {
        await replyVault(context, [error instanceof Error ? error.message : String(error)]);
      }
      return true;
    }

    if (parsed.action === "copy_shared") {
      try {
        const vaultId = ensureLoginVault(context);
        const result = context.services.vaultManager.copySharedVaultTo(parsed.name, vaultId);
        const refreshNote = await refreshCopiedVaultRuntime(context, vaultId);
        await replyVault(context, [
          `Copied shared login profile \`${parsed.name}\` into this conversation.`,
          "Shared values overwrite matching conversation values; conversation-only values are kept.",
          `Copied: ${result.envKeysCopied} env key(s), ${result.filesCopied} file(s).`,
          ...(refreshNote ? [refreshNote] : []),
        ]);
      } catch (error) {
        await replyVault(context, [error instanceof Error ? error.message : String(error)]);
      }
      return true;
    }

    if (!context.services.portalBaseUrl) {
      await replyVault(context, [
        "Login is not configured.",
        "Set `MIKAN_LINK_URL` or `MIKAN_LINK_PORT` on the server.",
      ]);
      return true;
    }

    const isSharedSetup = parsed.action === "shared_create" || parsed.action === "shared_update";
    let vaultId: string;
    try {
      vaultId = isSharedSetup ? (sharedVaultKey(parsed.name) ?? "") : ensureLoginVault(context);
      if (!vaultId) {
        throw new Error(
          isSharedSetup ? `Invalid shared login profile name: ${parsed.name}` : "Invalid vault id",
        );
      }
    } catch (error) {
      log.logWarning(
        `[${context.conversationId}] Failed to prepare login vault for ${context.platform}/${context.platformUserId}`,
        error instanceof Error ? error.message : String(error),
      );
      await replyVault(context, [
        "Login setup failed on the server.",
        "請稍後重試，或聯絡管理員檢查 vault 儲存權限。",
      ]);
      return true;
    }

    const token = context.services.linkTokenStore.create(
      context.platform,
      context.platformUserId,
      context.conversationId,
      vaultId,
      "",
    );
    const vaultLabel = isSharedSetup
      ? `shared login profile (${parsed.name})`
      : context.services.sandbox.type === "container"
        ? `container vault (${vaultId})`
        : "your vault";
    await replyVault(context, [
      `${context.services.portalBaseUrl}/link?token=${token.token}`,
      `Target: ${vaultLabel} · Expires: 15 minutes`,
    ]);
    return true;
  }
}
