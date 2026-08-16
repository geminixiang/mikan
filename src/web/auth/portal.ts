import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { readEnv } from "../../env-manifest.js";
import { isRecord } from "../../utils/file-guards.js";
import {
  buildOAuthAuthorizationUrl,
  exchangeOAuthCode,
  readBoundedResponseText,
} from "../oauth-flow.js";
import { normalizeReturnPath, type WebAuthRegistry } from "./registry.js";
import type { WebAccount, WebIdentityClaims, WebIdentityProvider } from "./types.js";

const SESSION_COOKIE = "mikan_web_session";
const CSRF_COOKIE = "mikan_web_csrf";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;

export interface AuthenticatedWebRequest {
  readonly account: WebAccount;
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export function authenticateWebRequest(
  req: IncomingMessage,
  registry: WebAuthRegistry,
  csrfHeader = false,
): AuthenticatedWebRequest | null {
  const cookies = readCookies(req);
  const token = cookies[SESSION_COOKIE];
  const csrfToken = cookies[CSRF_COOKIE];
  const suppliedCsrf = csrfHeader ? singleHeader(req.headers["x-mikan-csrf"]) : csrfToken;
  if (!token || !csrfToken || !suppliedCsrf || (csrfHeader && suppliedCsrf !== csrfToken)) {
    return null;
  }
  const session = registry.resolveLoginSession(token, suppliedCsrf);
  return session
    ? { account: session.account, token, csrfToken, expiresAt: session.expiresAt }
    : null;
}

export function enforceWebMutationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  publicBaseUrl?: string,
): boolean {
  if (singleHeader(req.headers["content-type"])?.toLowerCase() !== "application/json") {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return false;
  }
  const baseUrl = resolveCallbackBaseUrl(req, publicBaseUrl);
  if (!baseUrl || requestOrigin(req) !== new URL(baseUrl).origin) {
    sendJson(res, 403, { error: "Cross-origin request rejected" });
    return false;
  }
  return true;
}

export function sendWebJson(res: ServerResponse, status: number, value: unknown): void {
  sendJson(res, status, value);
}

export function clearWebSessionCookies(res: ServerResponse): void {
  clearSessionCookies(res);
}

export interface WebOAuthProviderConfig {
  readonly provider: WebIdentityProvider;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly profileUrl: string;
  readonly scopes: readonly string[];
}

export interface WebAuthRequestOptions {
  readonly registry: WebAuthRegistry;
  /** Canonical public origin. Required unless every request is loopback-local. */
  readonly publicBaseUrl?: string;
  readonly providers: Readonly<Partial<Record<WebIdentityProvider, WebOAuthProviderConfig>>>;
}

export function resolveWebOAuthProviders(): WebAuthRequestOptions["providers"] {
  const providers: Partial<Record<WebIdentityProvider, WebOAuthProviderConfig>> = {};
  const githubClientId = readEnv("WEB_GITHUB_OAUTH_CLIENT_ID");
  const githubClientSecret = readEnv("WEB_GITHUB_OAUTH_CLIENT_SECRET");
  if (githubClientId && githubClientSecret) {
    providers.github = {
      provider: "github",
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      profileUrl: "https://api.github.com/user",
      scopes: ["read:user", "user:email"],
    };
  }

  const googleClientId = readEnv("WEB_GOOGLE_OAUTH_CLIENT_ID");
  const googleClientSecret = readEnv("WEB_GOOGLE_OAUTH_CLIENT_SECRET");
  if (googleClientId && googleClientSecret) {
    providers.google = {
      provider: "google",
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: ["openid", "email", "profile"],
    };
  }
  return providers;
}

export function hasWebOAuthProvider(providers: WebAuthRequestOptions["providers"]): boolean {
  return providers.github !== undefined || providers.google !== undefined;
}

export async function handleWebAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: WebAuthRequestOptions,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/auth/providers") {
    sendJson(res, 200, {
      providers: (["github", "google"] as const).filter(
        (provider) => options.providers[provider] !== undefined,
      ),
    });
    return true;
  }

  const authMatch = /^\/auth\/(github|google)$/.exec(url.pathname);
  if (req.method === "GET" && authMatch) {
    await startOAuth(req, res, url, requireProvider(authMatch[1]!), options);
    return true;
  }

  const callbackMatch = /^\/auth\/(github|google)\/callback$/.exec(url.pathname);
  if (req.method === "GET" && callbackMatch) {
    await completeOAuth(req, res, url, requireProvider(callbackMatch[1]!), options);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/web/me") {
    handleMe(req, res, options.registry);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/web/logout") {
    handleLogout(req, res, options);
    return true;
  }

  return false;
}

async function startOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  provider: WebIdentityProvider,
  options: WebAuthRequestOptions,
): Promise<void> {
  const config = options.providers[provider];
  if (!config) return sendJson(res, 404, { error: "OAuth provider is not configured" });
  const baseUrl = resolveCallbackBaseUrl(req, options.publicBaseUrl);
  if (!baseUrl) return sendJson(res, 503, { error: "Web OAuth requires a canonical public URL" });

  let returnPath: string;
  try {
    returnPath = normalizeReturnPath(url.searchParams.get("returnTo") ?? "/");
  } catch {
    return sendJson(res, 400, { error: "Invalid return path" });
  }

  const transaction = options.registry.createOAuthTransaction(provider, returnPath);
  const redirectUri = `${baseUrl}/auth/${provider}/callback`;
  const authorizeUrl = buildOAuthAuthorizationUrl(config, {
    state: transaction.state,
    redirectUri,
    codeVerifier: transaction.codeVerifier,
  });
  res.writeHead(302, { Location: authorizeUrl.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function completeOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  provider: WebIdentityProvider,
  options: WebAuthRequestOptions,
): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const transaction = options.registry.consumeOAuthTransaction(state, provider);
  if (!transaction) return redirectOAuthError(res, "invalid_state");

  const providerError = url.searchParams.get("error");
  if (providerError) return redirectOAuthError(res, "denied");
  const code = url.searchParams.get("code") ?? "";
  if (!code) return redirectOAuthError(res, "missing_code");

  const config = options.providers[provider];
  const baseUrl = resolveCallbackBaseUrl(req, options.publicBaseUrl);
  if (!config || !baseUrl) return redirectOAuthError(res, "unavailable");

  try {
    const tokenResponse = await exchangeOAuthCode(config, {
      code,
      redirectUri: `${baseUrl}/auth/${provider}/callback`,
      codeVerifier: transaction.codeVerifier,
    });
    const accessToken = tokenResponse.access_token?.trim();
    if (!accessToken) return redirectOAuthError(res, "provider_failed");

    const claims =
      provider === "github"
        ? await fetchGitHubClaims(config, accessToken)
        : await fetchGoogleClaims(config, accessToken);
    const { account } = options.registry.completeOAuthIdentity(claims);

    const previousToken = readCookies(req)[SESSION_COOKIE];
    if (previousToken) options.registry.revokeLoginSession(previousToken);
    const session = options.registry.createLoginSession(account.id);
    const secure = baseUrl.startsWith("https://");
    res.writeHead(302, {
      Location: transaction.returnPath,
      "Cache-Control": "no-store",
      "Set-Cookie": [
        serializeCookie(SESSION_COOKIE, session.token, session.expiresAt, secure, true),
        serializeCookie(CSRF_COOKIE, session.csrfToken, session.expiresAt, secure, false),
      ],
    });
    res.end();
  } catch {
    redirectOAuthError(res, "provider_failed");
  }
}

function handleMe(req: IncomingMessage, res: ServerResponse, registry: WebAuthRegistry): void {
  const session = authenticateWebRequest(req, registry);
  if (!session) {
    clearSessionCookies(res);
    return sendJson(res, 401, { error: "Authentication required" });
  }
  sendJson(res, 200, {
    account: publicAccount(session),
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  });
}

function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  options: WebAuthRequestOptions,
): void {
  if (!enforceWebMutationRequest(req, res, options.publicBaseUrl)) return;
  const session = authenticateWebRequest(req, options.registry, true);
  if (!session) {
    clearSessionCookies(res);
    return sendJson(res, 401, { error: "Authentication required" });
  }
  options.registry.revokeLoginSession(session.token);
  clearSessionCookies(res);
  res.writeHead(204);
  res.end();
}

async function fetchGitHubClaims(
  config: WebOAuthProviderConfig,
  accessToken: string,
): Promise<WebIdentityClaims> {
  const profile = await fetchProviderJson(config.profileUrl, accessToken, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const id = profile.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("GitHub profile did not include a valid immutable id");
  }
  const login = nonEmptyString(profile.login);
  const displayName = nonEmptyString(profile.name) ?? login;
  if (!displayName) throw new Error("GitHub profile did not include a display name");

  let email = nonEmptyString(profile.email);
  let emailVerified: boolean | undefined;
  if (!email) {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: providerHeaders(accessToken, {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
    });
    const value = await fetchProviderValue(response);
    if (!Array.isArray(value)) throw new Error("GitHub emails response was invalid");
    const emails = value.filter(isRecord);
    const selected =
      emails.find((item) => item.primary === true && item.verified === true) ??
      emails.find((item) => item.verified === true);
    email = selected ? nonEmptyString(selected.email) : undefined;
    emailVerified = email ? true : undefined;
  }

  return {
    provider: "github",
    subject: String(id),
    displayName,
    ...(email ? { email } : {}),
    ...(emailVerified !== undefined ? { emailVerified } : {}),
    ...(nonEmptyString(profile.avatar_url)
      ? { avatarUrl: nonEmptyString(profile.avatar_url)! }
      : {}),
  };
}

async function fetchGoogleClaims(
  config: WebOAuthProviderConfig,
  accessToken: string,
): Promise<WebIdentityClaims> {
  const profile = await fetchProviderJson(config.profileUrl, accessToken);
  const subject = nonEmptyString(profile.sub);
  if (!subject) throw new Error("Google profile did not include an immutable subject");
  const email = nonEmptyString(profile.email);
  const displayName = nonEmptyString(profile.name) ?? email;
  if (!displayName) throw new Error("Google profile did not include a display name");
  return {
    provider: "google",
    subject,
    displayName,
    ...(email ? { email } : {}),
    ...(typeof profile.email_verified === "boolean"
      ? { emailVerified: profile.email_verified }
      : {}),
    ...(nonEmptyString(profile.picture) ? { avatarUrl: nonEmptyString(profile.picture)! } : {}),
  };
}

async function fetchProviderJson(
  url: string,
  accessToken: string,
  headers?: Readonly<Record<string, string>>,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: providerHeaders(accessToken, headers) });
  const value = await fetchProviderValue(response);
  if (!isRecord(value)) throw new Error("OAuth provider profile response was invalid");
  return value;
}

async function fetchProviderValue(response: Response): Promise<unknown> {
  const text = await readBoundedResponseText(response, MAX_PROVIDER_RESPONSE_BYTES);
  if (!response.ok)
    throw new Error(`OAuth provider profile request failed: HTTP ${response.status}`);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("OAuth provider profile response was invalid", { cause: error });
  }
}

function providerHeaders(
  accessToken: string,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

function resolveCallbackBaseUrl(
  req: IncomingMessage,
  configuredBaseUrl: string | undefined,
): string | null {
  if (configuredBaseUrl) {
    try {
      const parsed = new URL(configuredBaseUrl);
      if (
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        return null;
      }
      if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) return null;
      return parsed.origin;
    } catch {
      return null;
    }
  }

  const remoteAddress = req.socket.remoteAddress;
  const host = singleHeader(req.headers.host);
  if (!remoteAddress || !isLoopbackAddress(remoteAddress) || !host) return null;
  try {
    const parsed = new URL(`http://${host}`);
    return isLoopbackHostname(parsed.hostname) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = singleHeader(req.headers.origin)?.trim();
  if (origin && origin !== "null") {
    try {
      return new URL(origin).origin;
    } catch {
      return undefined;
    }
  }
  const referer = singleHeader(req.headers.referer)?.trim();
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || isLoopbackAddress(normalized);
}

function readCookies(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (singleHeader(req.headers.cookie) ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try {
      result[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookie values rather than widening authentication errors.
    }
  }
  return result;
}

function serializeCookie(
  name: string,
  value: string,
  expiresAt: number,
  secure: boolean,
  httpOnly: boolean,
): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
    ...(httpOnly ? ["HttpOnly"] : []),
  ].join("; ");
}

function clearSessionCookies(res: ServerResponse): void {
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
    `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
  ]);
}

function publicAccount(session: AuthenticatedWebRequest): WebAccount {
  return session.account;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireProvider(value: string): WebIdentityProvider {
  if (value !== "github" && value !== "google") throw new Error("Unsupported OAuth provider");
  return value;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function redirectOAuthError(
  res: ServerResponse,
  code: "denied" | "invalid_state" | "missing_code" | "provider_failed" | "unavailable",
): void {
  res.writeHead(302, {
    Location: `/?authError=${code}`,
    "Cache-Control": "no-store",
  });
  res.end();
}
