import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MessagingBot, ConversationContext, PlatformName } from "../adapter.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { SandboxConfig } from "../sandbox/index.js";
import type { SandboxResourceController } from "../types.js";
import type { VaultManager } from "../vault/index.js";

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
}

export interface ParsedSandboxCommand {
  action?: "boost" | "private" | "full";
}

export type ParsedLoginCommand =
  | { action: "setup" }
  | { action: "shared_create" | "shared_update" | "shared_delete"; name: string }
  | { action: "shared_list" }
  | { action: "copy_shared"; name: string };
