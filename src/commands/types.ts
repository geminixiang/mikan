import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MessagingBot, ConversationContext, PlatformName } from "../adapter.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { SandboxConfig } from "../sandbox/index.js";
import type { SandboxResourceController } from "../types.js";
import type { VaultManager } from "../vault/index.js";

interface CommandArgSpec {
  name: string;
  description: string;
  required: boolean;
}

/**
 * Data for the Slack adapter's generic slash route (how the synthesized
 * command event is built). All flags default to false.
 */
export interface SlackSlashRoute {
  /** Append the slash payload's free text to the synthesized command text. */
  includeText?: boolean;
  /** Scope the event to the invoking thread (thread-scoped session key). */
  thread?: boolean;
  /** Outside DMs, mark the event `private_command` so replies stay between the bot and the user. */
  privateCommand?: boolean;
}

export interface CommandManifestEntry {
  /** Canonical name without slash, e.g. "login"; `/login` and `/pi-login` are derived. */
  name: string;
  description: string;
  /** Extra accepted spellings beyond `name` (e.g. "autoreply"); each also gets a `pi-` form. */
  aliases?: readonly string[];
  /** Optional single free-text argument for platforms that register typed args. */
  arg?: CommandArgSpec;
  /** Accepted without a leading slash. Per CONTEXT.md, only `session`. */
  bare?: boolean;
  /**
   * Routed by conversation intake as a magic word, never by a command
   * handler. Such an entry exists for platform registration/UI only.
   */
  magicWord?: boolean;
  /** Slack slash-command name, e.g. "/pi-login". Absent = not a Slack slash command. */
  slackCommand?: string;
  /** Slack routing data; absent for `new`, whose Slack dispatch is bespoke. */
  slackRoute?: SlackSlashRoute;
  /** Registered as a Discord application command. */
  discord?: boolean;
  /** Listed in Telegram's command menu; `description` overrides the shared one. */
  telegramMenu?: { description?: string };
}

export interface LinkTokenStoreLike {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    vaultId: string,
    providerId: string,
  ): { token: string };
}

export interface SessionViewTokenStoreLike {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    sessionKey: string,
    sessionFile: string,
    platformUserName?: string,
  ): { token: string };
}

export interface AdminTokenStoreLike {
  create(args: {
    platform: PlatformName;
    platformUserId: string;
    conversationId: string;
    platformUserName?: string;
  }): { token: string };
}

interface CommandRuntimeBridge {
  handleNewCommand(
    sessionKey: string,
    conversationId: string,
    bot: MessagingBot,
    message: ConversationContext["message"],
    responder: ConversationContext["responder"],
    platform: ConversationContext["platform"],
  ): Promise<void>;
  switchConversationModel(conversationId: string, provider: string, model: string): boolean;
  refreshConversationEnvironment(conversationId: string): boolean;
}

export interface CommandServices {
  workingDir: string;
  runtime?: CommandRuntimeBridge;
  sandbox: SandboxConfig;
  vaultManager: VaultManager;
  provisioner?: DockerContainerManager;
  resourceController?: SandboxResourceController;
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore: SessionViewTokenStoreLike;
  adminTokenStore: AdminTokenStoreLike;
  portalBaseUrl?: string;
}

export interface CommandContext {
  bot: MessagingBot;
  responder: ConversationContext["responder"];
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  conversationId: string;
  vaultConversationId?: string;
  sessionKey: string;
  commandText: string;
  privateConversation: boolean;
  services: CommandServices;
}

export interface CommandHandler {
  tryHandle(context: CommandContext): Promise<boolean>;
}

// ── command-specific parsed types ────────────────────────────────────────────

export interface ParsedModelCommand {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  error?: "invalid_spec" | "unknown_thinking_level";
}

export interface ParsedSandboxCommand {
  action?: "boost" | "private" | "full";
}

export type ParsedLoginCommand =
  | { action: "setup" }
  | { action: "shared_create" | "shared_update" | "shared_delete"; name: string }
  | { action: "shared_list" }
  | { action: "copy_shared"; name: string };
