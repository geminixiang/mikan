export type WebIdentityProvider = "github" | "google";

export interface WebAccount {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebIdentity {
  readonly provider: WebIdentityProvider;
  readonly subject: string;
  readonly accountId: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly profileName?: string;
  readonly avatarUrl?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebWorkspaceRecord {
  readonly id: string;
  readonly ownerAccountId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebIdentityClaims {
  provider: WebIdentityProvider;
  subject: string;
  displayName: string;
  email?: string;
  emailVerified?: boolean;
  avatarUrl?: string;
}

export interface WebLoginSession {
  readonly account: WebAccount;
  readonly expiresAt: number;
}

export interface CreatedWebLoginSession extends WebLoginSession {
  readonly token: string;
  readonly csrfToken: string;
}

export interface CreatedWebOAuthTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAt: number;
}

export interface WebOAuthTransaction {
  readonly provider: WebIdentityProvider;
  readonly codeVerifier: string;
  readonly returnPath: string;
  readonly expiresAt: number;
}
