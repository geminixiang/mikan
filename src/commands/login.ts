import * as log from "../log.js";
import { credentialAuthorizationKey, runtimeResourceKey } from "../sandbox/identity.js";
import { sharedVaultKey } from "../vault/index.js";
import { slashForms } from "./manifest.js";
import { matchCommand } from "./manifest.js";
import type { CommandContext, CommandHandler, ParsedLoginCommand } from "./types.js";
import { portalNotConfiguredLines, replySummary } from "./utils.js";
import { createOfficeAddress } from "../office/index.js";

const LOGIN_COMMANDS = slashForms("login");

const SHARED_OPERATIONS = ["create", "update", "delete"] as const;

export function parseLoginCommand(text: string): ParsedLoginCommand | null {
  const matched = matchCommand(text, LOGIN_COMMANDS);
  if (!matched) return null;

  const [subcommand, operation, name, ...extra] = matched.args;
  if (!subcommand) return { action: "setup" };
  if (extra.length > 0) return null;

  const verb = subcommand.toLowerCase();
  if (verb === "shared") return parseSharedLogin(operation?.toLowerCase(), name);
  if (verb === "copy" && operation && !name) return { action: "copy_shared", name: operation };
  // Backward-compatible provider arguments open the generic login page.
  return operation ? null : { action: "setup" };
}

function parseSharedLogin(
  operation: string | undefined,
  name: string | undefined,
): ParsedLoginCommand | null {
  if (operation === "list") return name ? null : { action: "shared_list" };
  const matched = SHARED_OPERATIONS.find((candidate) => candidate === operation);
  if (!matched || !name) return null;
  return { action: `shared_${matched}`, name };
}

function ensureLoginVault(context: CommandContext): string {
  const { services, platformUserId, conversationId, vaultConversationId } = context;
  // The vault target is a conversation on the same platform; a command may
  // aim at another conversation's vault via vaultConversationId.
  return credentialAuthorizationKey(services.sandbox, {
    userId: platformUserId,
    address: createOfficeAddress(context.address.platform, vaultConversationId ?? conversationId),
  });
}

async function refreshCopiedVaultRuntime(context: CommandContext): Promise<string | undefined> {
  if (context.services.sandbox.type !== "image") return undefined;

  const targetAddress = createOfficeAddress(
    context.address.platform,
    context.vaultConversationId ?? context.conversationId,
  );
  const cleared = context.services.runtime?.refreshConversationEnvironment(targetAddress);
  if (cleared === false) {
    return "A session is currently running, so the sandbox was not restarted. The copied credentials will be applied after the run finishes and the sandbox is recreated.";
  }

  if (!context.services.provisioner) {
    return "The cached session was refreshed. The sandbox will pick up copied credentials on the next provision.";
  }

  // The provisioner names containers by runtime resource key, not by the
  // credential key the vault copy used — the two identities differ in image
  // mode (office key vs raw-conversation key). Removing by the wrong key
  // would silently leave the real container running with stale mounts.
  const resourceKey = runtimeResourceKey(context.services.sandbox, {
    userId: context.platformUserId,
    address: targetAddress,
  });
  await context.services.provisioner.remove(resourceKey);
  return "The sandbox container was removed and will be recreated with the copied env and file mounts on the next message.";
}

export class LoginCommandHandler implements CommandHandler {
  async tryHandle(context: CommandContext): Promise<boolean> {
    const parsed = parseLoginCommand(context.commandText);
    if (!parsed) return false;

    if (!context.privateConversation) {
      await replySummary(context, "Vault", [
        "為了保護你的憑證，`/login` 只能在與機器人的私訊中使用。",
        "請先私訊機器人，再重新執行 `/login`。",
      ]);
      return true;
    }

    if (parsed.action === "shared_list") await listSharedProfiles(context);
    else if (parsed.action === "shared_delete") await deleteSharedProfile(context, parsed.name);
    else if (parsed.action === "copy_shared") await copySharedProfile(context, parsed.name);
    else await startLoginSetup(context, parsed);
    return true;
  }
}

async function listSharedProfiles(context: CommandContext): Promise<void> {
  const profiles = context.services.vaultManager.listSharedVaults();
  await replySummary(
    context,
    "Vault",
    profiles.length > 0
      ? ["Shared login profiles:", ...profiles.map((name) => `- ${name}`)]
      : ["No shared login profiles found."],
  );
}

async function deleteSharedProfile(context: CommandContext, name: string): Promise<void> {
  try {
    const deleted = context.services.vaultManager.deleteSharedVault(name);
    await replySummary(context, "Vault", [
      deleted
        ? `Deleted shared login profile \`${name}\`.`
        : `Shared login profile \`${name}\` does not exist.`,
    ]);
  } catch (error) {
    await replySummary(context, "Vault", [error instanceof Error ? error.message : String(error)]);
  }
}

async function copySharedProfile(context: CommandContext, name: string): Promise<void> {
  try {
    const vaultId = ensureLoginVault(context);
    const result = context.services.vaultManager.copySharedVaultTo(name, vaultId);
    const refreshNote = await refreshCopiedVaultRuntime(context);
    await replySummary(context, "Vault", [
      `Copied shared login profile \`${name}\` into this conversation.`,
      "Shared values overwrite matching conversation values; conversation-only values are kept.",
      `Copied: ${result.envKeysCopied} env key(s), ${result.filesCopied} file(s).`,
      ...(refreshNote ? [refreshNote] : []),
    ]);
  } catch (error) {
    await replySummary(context, "Vault", [error instanceof Error ? error.message : String(error)]);
  }
}

/** Issue a portal link for this conversation's vault, or for a shared profile. */
async function startLoginSetup(context: CommandContext, parsed: ParsedLoginCommand): Promise<void> {
  if (!context.services.portalBaseUrl) {
    await replySummary(context, "Vault", portalNotConfiguredLines("Login"));
    return;
  }

  let vaultId: string;
  try {
    vaultId = resolveLoginVaultId(context, parsed);
  } catch (error) {
    log.logWarning(
      `[${context.conversationId}] Failed to prepare login vault for ${context.platform}/${context.platformUserId}`,
      error instanceof Error ? error.message : String(error),
    );
    await replySummary(context, "Vault", [
      "Login setup failed on the server.",
      "請稍後重試，或聯絡管理員檢查 vault 儲存權限。",
    ]);
    return;
  }

  const token = context.services.linkTokenStore.create(
    context.platform,
    context.platformUserId,
    context.conversationId,
    vaultId,
    "",
  );
  await replySummary(context, "Vault", [
    `${context.services.portalBaseUrl}/link?token=${token.token}`,
    `Target: ${loginVaultLabel(context, parsed, vaultId)} · Expires: 15 minutes`,
  ]);
}

function resolveLoginVaultId(context: CommandContext, parsed: ParsedLoginCommand): string {
  const isSharedSetup = parsed.action === "shared_create" || parsed.action === "shared_update";
  const vaultId = isSharedSetup ? (sharedVaultKey(parsed.name) ?? "") : ensureLoginVault(context);
  if (vaultId) return vaultId;
  throw new Error(
    isSharedSetup ? `Invalid shared login profile name: ${parsed.name}` : "Invalid vault id",
  );
}

function loginVaultLabel(
  context: CommandContext,
  parsed: ParsedLoginCommand,
  vaultId: string,
): string {
  if (parsed.action === "shared_create" || parsed.action === "shared_update") {
    return `shared login profile (${parsed.name})`;
  }
  return context.services.sandbox.type === "container"
    ? `container vault (${vaultId})`
    : "your vault";
}
