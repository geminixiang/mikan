import type { PlatformName } from "../../../types.js";
import type { TokenRecord } from "../types.js";

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
  accessTokenEnvKeys?: string[];
  refreshTokenEnvKey?: string;
  authorizationParams?: Record<string, string>;
  fileOutput?: OAuthAuthorizedUserFileOutput;
}

export interface LinkToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  vaultId: string;
  providerId: string;
  conversationId: string;
}

export type NotifyFn = (platform: string, conversationId: string, message: string) => Promise<void>;
