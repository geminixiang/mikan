import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
export type { GcpTokenProviderOptions } from "./types.js";
import type { GcpTokenProviderOptions } from "./types.js";

/**
 * Minimal Google Application Default Credentials provider — enough to mint
 * cloud-platform access tokens on the host without pulling in
 * google-auth-library (this repo hand-rolls its GitHub App JWTs the same way).
 *
 * Supported `GOOGLE_APPLICATION_CREDENTIALS` JSON shapes:
 *  - `external_account` (Workload Identity Federation) with a file or url
 *    credential source: STS token exchange, plus optional service-account
 *    impersonation. AWS/executable sources are rejected with a clear error.
 *  - `service_account` key: self-signed JWT assertion grant.
 *  - `authorized_user` (gcloud user ADC): refresh-token grant. Local dev.
 */

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Refresh cached tokens this long before expiry — STS/impersonation tokens
 *  live ~1h; minting per request would hammer STS in a CI-debug loop. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface ExternalAccountCredentials {
  type: "external_account";
  audience: string;
  subject_token_type: string;
  token_url: string;
  service_account_impersonation_url?: string;
  credential_source: {
    file?: string;
    url?: string;
    headers?: Record<string, string>;
    format?: { type?: string; subject_token_field_name?: string };
  };
}

interface ServiceAccountCredentials {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface AuthorizedUserCredentials {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

type AdcCredentials =
  | ExternalAccountCredentials
  | ServiceAccountCredentials
  | AuthorizedUserCredentials;

function base64Url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

export class GcpAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GcpAuthError";
  }
}

export class GcpTokenProvider {
  private readonly credentialsPath: string;
  private readonly fetchImpl: typeof fetch;
  private credentials: AdcCredentials | null = null;
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(options: GcpTokenProviderOptions) {
    this.credentialsPath = options.credentialsPath;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** A valid cloud-platform access token, cached until near expiry. */
  async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    // Single-flight: concurrent tool calls must not each hit STS.
    this.inFlight ??= this.mintToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private loadCredentials(): AdcCredentials {
    if (this.credentials) return this.credentials;
    let parsed: AdcCredentials;
    try {
      parsed = JSON.parse(readFileSync(this.credentialsPath, "utf-8")) as AdcCredentials;
    } catch (err) {
      throw new GcpAuthError(
        `Cannot read GCP credentials at ${this.credentialsPath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!["external_account", "service_account", "authorized_user"].includes(parsed.type)) {
      throw new GcpAuthError(
        `Unsupported GCP credential type '${(parsed as { type?: string }).type}' — expected ` +
          `external_account (WIF), service_account, or authorized_user.`,
      );
    }
    this.credentials = parsed;
    return parsed;
  }

  private async mintToken(): Promise<string> {
    const credentials = this.loadCredentials();
    let minted: { token: string; expiresInSeconds: number };
    switch (credentials.type) {
      case "external_account":
        minted = await this.mintExternalAccount(credentials);
        break;
      case "service_account":
        minted = await this.mintServiceAccount(credentials);
        break;
      case "authorized_user":
        minted = await this.mintAuthorizedUser(credentials);
        break;
    }
    this.cached = {
      token: minted.token,
      expiresAt: Date.now() + minted.expiresInSeconds * 1000,
    };
    return minted.token;
  }

  private async postForm(
    url: string,
    form: Record<string, string>,
    context: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new GcpAuthError(`${context} failed with ${response.status}: ${detail}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  /** WIF: read the subject token, exchange at STS, optionally impersonate. */
  private async mintExternalAccount(
    credentials: ExternalAccountCredentials,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const subjectToken = await this.readSubjectToken(credentials);
    const sts = await this.postForm(
      credentials.token_url,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: credentials.audience,
        scope: CLOUD_PLATFORM_SCOPE,
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token: subjectToken,
        subject_token_type: credentials.subject_token_type,
      },
      "GCP STS token exchange",
    );
    const stsToken = sts.access_token as string;
    const stsExpires = (sts.expires_in as number | undefined) ?? 3600;
    if (!credentials.service_account_impersonation_url) {
      return { token: stsToken, expiresInSeconds: stsExpires };
    }

    const response = await this.fetchImpl(credentials.service_account_impersonation_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${stsToken}`,
      },
      body: JSON.stringify({ scope: [CLOUD_PLATFORM_SCOPE] }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new GcpAuthError(
        `GCP service-account impersonation failed with ${response.status}: ${detail}`,
      );
    }
    const impersonated = (await response.json()) as { accessToken: string; expireTime: string };
    const expiresInSeconds = Math.max(
      0,
      Math.floor((Date.parse(impersonated.expireTime) - Date.now()) / 1000),
    );
    return { token: impersonated.accessToken, expiresInSeconds };
  }

  private async readSubjectToken(credentials: ExternalAccountCredentials): Promise<string> {
    const source = credentials.credential_source;
    let raw: string;
    if (source.file) {
      raw = readFileSync(source.file, "utf-8").trim();
    } else if (source.url) {
      const response = await this.fetchImpl(source.url, { headers: source.headers });
      if (!response.ok) {
        throw new GcpAuthError(
          `WIF credential_source url returned ${response.status} — cannot read subject token`,
        );
      }
      raw = (await response.text()).trim();
    } else {
      throw new GcpAuthError(
        "Unsupported WIF credential_source: only file and url sources are supported " +
          "(aws/executable sources are not).",
      );
    }
    if (source.format?.type === "json") {
      const field = source.format.subject_token_field_name ?? "token";
      const parsed = JSON.parse(raw) as Record<string, string>;
      const token = parsed[field];
      if (!token) {
        throw new GcpAuthError(`WIF subject token field '${field}' missing from JSON source`);
      }
      return token;
    }
    return raw;
  }

  /** Service-account key: self-signed RS256 JWT → assertion grant. */
  private async mintServiceAccount(
    credentials: ServiceAccountCredentials,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const tokenUrl = credentials.token_uri ?? OAUTH_TOKEN_URL;
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: CLOUD_PLATFORM_SCOPE,
        aud: tokenUrl,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signature = createSign("RSA-SHA256")
      .update(`${header}.${payload}`)
      .sign(credentials.private_key)
      .toString("base64url");
    const data = await this.postForm(
      tokenUrl,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${payload}.${signature}`,
      },
      "GCP service-account token grant",
    );
    return {
      token: data.access_token as string,
      expiresInSeconds: (data.expires_in as number | undefined) ?? 3600,
    };
  }

  /** gcloud user ADC: refresh-token grant. */
  private async mintAuthorizedUser(
    credentials: AuthorizedUserCredentials,
  ): Promise<{ token: string; expiresInSeconds: number }> {
    const data = await this.postForm(
      OAUTH_TOKEN_URL,
      {
        grant_type: "refresh_token",
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      },
      "GCP user-credential refresh",
    );
    return {
      token: data.access_token as string,
      expiresInSeconds: (data.expires_in as number | undefined) ?? 3600,
    };
  }
}
