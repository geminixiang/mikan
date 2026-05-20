import type { Bot, BotAdapters, PlatformName } from "../adapter.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import type { SandboxConfig } from "../sandbox/index.js";
import type { VaultManager } from "../vault.js";

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

export interface CommandServices {
  workingDir: string;
  runtime?: SessionRuntime;
  sandbox: SandboxConfig;
  vaultManager: VaultManager;
  provisioner?: DockerContainerManager;
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore: SessionViewTokenStoreLike;
  portalBaseUrl?: string;
}

export interface CommandContext {
  bot: Bot;
  responseCtx: BotAdapters["responseCtx"];
  platform: PlatformName;
  platformUserId: string;
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
