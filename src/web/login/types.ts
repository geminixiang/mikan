import type { PlatformName } from "../../adapter.js";

export type LoginCredentialKind = "api_key" | "oauth";

interface OAuthAuthorizedUserFileOutput {
  type: "authorized_user";
  relativePath: string;
  targetPath?: string;
  envKey?: string;
  additionalEnvKeys?: string[];
}

export interface OAuthService {
  id: string;
  label: string;
  aliases: string[];
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnvKey: string;
  clientSecretEnvKey: string;
  accessTokenEnvKey?: string;
  additionalAccessTokenEnvKeys?: string[];
  refreshTokenEnvKey?: string;
  authorizationParams?: Record<string, string>;
  fileOutput?: OAuthAuthorizedUserFileOutput;
}

export type ParsedLoginCommand =
  | { command: "login" | "/login" | "/pi-login"; action: "setup" }
  | {
      command: "login" | "/login" | "/pi-login";
      action: "shared_create" | "shared_update" | "shared_delete";
      name: string;
    }
  | { command: "login" | "/login" | "/pi-login"; action: "shared_list" }
  | { command: "login" | "/login" | "/pi-login"; action: "copy_shared"; name: string };

export interface LinkToken {
  token: string;
  platform: PlatformName;
  platformUserId: string;
  vaultId: string;
  providerId: string;
  /** Conversation to notify when binding completes */
  conversationId: string;
  expiresAt: number;
}

/** Called after a binding is written, to notify the user in chat */
export type NotifyFn = (platform: string, conversationId: string, message: string) => Promise<void>;
