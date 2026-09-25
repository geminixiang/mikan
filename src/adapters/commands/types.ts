import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { Workspace } from "../../office/types.js";
import type { DockerContainerManager } from "../../sandbox/provisioner.js";
import type { SandboxConfig } from "../../sandbox/types.js";
import type {
  SandboxResourceController,
  ConversationContext,
  HandleNewCommandOptions,
  MessagingBot,
  OfficeAddress,
  PlatformName,
  SessionViewTokenStoreLike,
} from "../../types.js";
import type { VaultManager } from "../../vault/types.js";
import type { AdminTokenCreateOptions } from "../web/admin/types.js";

interface CommandArgSpec {
  name: string;
  description: string;
  required: boolean;
}

export interface SlackSlashRoute {
  includeText?: boolean;
  thread?: boolean;
  privateCommand?: boolean;
}

export interface CommandManifestEntry {
  name: string;
  description: string;
  aliases?: readonly string[];
  arg?: CommandArgSpec;
  bare?: boolean;
  magicWord?: boolean;
  slackCommand?: string;
  slackRoute?: SlackSlashRoute;
  discord?: boolean;
  telegramMenu?: { description?: string };
  telegramCommand?: boolean;
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

export interface AdminTokenStoreLike {
  create(options: AdminTokenCreateOptions): { token: string };
}

interface CommandRuntimeBridge {
  handleNewCommand(options: HandleNewCommandOptions): Promise<void>;
  switchConversationModel(address: OfficeAddress, provider: string, model: string): boolean;
  refreshConversationEnvironment(address: OfficeAddress): boolean;
}

export interface CommandServices {
  workspace: Workspace;
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
  address: OfficeAddress;
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

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ParsedModelCommand {
  provider?: string;
  model?: string;
  modelCandidate?: string;
  thinkingLevelCandidate?: string;
  thinkingLevel?: ThinkingLevel;
  error?: "invalid_spec";
}

export interface ParsedSandboxCommand {
  action?: "boost" | "visibility";
  visibility?: string;
}

export type ParsedLoginCommand =
  | { action: "setup" }
  | { action: "shared_create" | "shared_update" | "shared_delete"; name: string }
  | { action: "shared_list" }
  | { action: "copy_shared"; name: string };
