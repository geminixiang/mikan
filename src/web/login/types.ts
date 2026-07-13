import type { PlatformName } from "../../adapter.js";
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
  /** Env var names for reading the OAuth client credentials (input). */
  clientIdEnvKey: string;
  clientSecretEnvKey: string;
  /** Env var names to write the access token into after a successful exchange (output). */
  accessTokenEnvKeys?: string[];
  /** Env var name to write the refresh token into after a successful exchange (output). */
  refreshTokenEnvKey?: string;
  authorizationParams?: Record<string, string>;
  fileOutput?: OAuthAuthorizedUserFileOutput;
}

export interface LinkToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  vaultId: string;
  providerId: string;
  /** Conversation to notify when binding completes */
  conversationId: string;
}

/** Called after a binding is written, to notify the user in chat */
export type NotifyFn = (platform: string, conversationId: string, message: string) => Promise<void>;
