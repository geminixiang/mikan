import { createHash } from "node:crypto";

export interface OAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly authorizationParams?: Readonly<Record<string, string>>;
}

interface OAuthExchangeOptions {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly maxResponseBytes?: number;
}

const DEFAULT_MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

function createPkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function buildOAuthAuthorizationUrl(
  config: OAuthClientConfig,
  options: { state: string; redirectUri: string; codeVerifier: string },
): URL {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  if (config.scopes.length > 0) url.searchParams.set("scope", config.scopes.join(" "));
  for (const [key, value] of Object.entries(config.authorizationParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("code_challenge", createPkceChallenge(options.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function exchangeOAuthCode(
  config: OAuthClientConfig,
  options: OAuthExchangeOptions,
): Promise<Record<string, string>> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  const text = await readBoundedResponseText(
    response,
    options.maxResponseBytes ?? DEFAULT_MAX_TOKEN_RESPONSE_BYTES,
  );
  const parsed = parseOAuthTokenResponse(text, response.headers.get("content-type") ?? "");
  if (!response.ok) {
    const detail = parsed.error_description ?? parsed.error ?? `HTTP ${response.status}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  return parsed;
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("OAuth provider response exceeded the size limit");
  }

  // `text()` is retained as a fallback for the lightweight Response doubles used
  // by embedders and tests. Native fetch responses take the streaming path.
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error("OAuth provider response exceeded the size limit");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("OAuth provider response exceeded the size limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseOAuthTokenResponse(text: string, contentType: string): Record<string, string> {
  if (!contentType.includes("application/json")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("OAuth provider returned invalid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("OAuth provider returned an invalid token response");
  }
  const entries = Object.entries(value);
  if (entries.some((entry): boolean => typeof entry[1] !== "string")) {
    throw new Error("OAuth provider returned an invalid token response");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
