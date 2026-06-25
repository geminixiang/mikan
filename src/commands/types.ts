import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Bot, BotAdapters, PlatformName } from "../adapter.js";
import type { DockerContainerManager } from "../provisioner.js";
import type { ConversationRuntime } from "../runtime/conversation-runtime.js";
import type { SandboxConfig } from "../sandbox/index.js";
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

interface AdminTokenStoreLike {
  create(args: {
    platform: PlatformName;
    platformUserId: string;
    conversationId: string;
    platformUserName?: string;
  }): { token: string };
}

export interface CommandServices {
  workingDir: string;
  runtime?: ConversationRuntime;
  sandbox: SandboxConfig;
  vaultManager: VaultManager;
  provisioner?: DockerContainerManager;
  linkTokenStore: LinkTokenStoreLike;
  sessionViewTokenStore: SessionViewTokenStoreLike;
  adminTokenStore: AdminTokenStoreLike;
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

// ── command-specific parsed types ────────────────────────────────────────────

export interface ParsedModelCommand {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ParsedSandboxCommand {
  action?: "boost" | "private" | "full";
}
