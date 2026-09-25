import { readEnv } from "../../../env-manifest.js";
import { isRecord, parseJsonValue } from "../../../file-guards.js";
import * as log from "../../../log.js";
import { GOOGLE_VAULT_CREDENTIAL_FILES } from "../../../vault/index.js";

export type { LoginCredentialKind, OAuthService } from "./types.js";
import type { OAuthService } from "./types.js";

const DEFAULT_GOOGLE_WORKSPACE_CLI_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/chat.messages.create",
];

const DEFAULT_GOOGLE_CLOUD_SDK_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/cloud-platform",
];

const DEFAULT_GITHUB_OAUTH_SCOPES = ["repo", "read:user", "user:email", "read:org", "gist"];

function resolveScopesFromEnv(envKey: string, fallback: string[]): string[] {
  const raw = readEnv(envKey);
  if (!raw) return fallback;

  const scopes = raw.split(/[\s,]+/).filter(Boolean);

  return scopes.length > 0 ? scopes : fallback;
}

function getBuiltinOAuthServices(): OAuthService[] {
  return [
    {
      id: "github",
      label: "GitHub",
      aliases: ["github", "github_oauth", "gh_oauth"],
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: resolveScopesFromEnv("GITHUB_OAUTH_SCOPES", DEFAULT_GITHUB_OAUTH_SCOPES),
      clientIdEnvKey: "GITHUB_OAUTH_CLIENT_ID",
      clientSecretEnvKey: "GITHUB_OAUTH_CLIENT_SECRET",
      accessTokenEnvKeys: ["GITHUB_OAUTH_ACCESS_TOKEN", "GH_TOKEN"],
      refreshTokenEnvKey: "GITHUB_OAUTH_REFRESH_TOKEN",
    },
    {
      id: "google_workspace_cli",
      label: "Google Workspace CLI",
      aliases: ["google_workspace_cli", "gws", "googleworkspace", "google-workspace-cli"],
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: resolveScopesFromEnv(
        "GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES",
        DEFAULT_GOOGLE_WORKSPACE_CLI_SCOPES,
      ),
      clientIdEnvKey: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      clientSecretEnvKey: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
      authorizationParams: {
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent",
      },
      fileOutput: {
        type: "authorized_user",
        relativePath: GOOGLE_VAULT_CREDENTIAL_FILES.workspaceCli.relativePath,
        targetPath: GOOGLE_VAULT_CREDENTIAL_FILES.workspaceCli.targetPath,
      },
    },
    {
      id: "google_cloud_sdk",
      label: "Google Cloud SDK (gcloud)",
      aliases: ["google_cloud_sdk", "gcloud", "google-cloud-sdk", "google_cloud", "gcp"],
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: resolveScopesFromEnv(
        "GOOGLE_CLOUD_SDK_OAUTH_SCOPES",
        DEFAULT_GOOGLE_CLOUD_SDK_SCOPES,
      ),
      clientIdEnvKey: "GOOGLE_CLOUD_SDK_CLIENT_ID",
      clientSecretEnvKey: "GOOGLE_CLOUD_SDK_CLIENT_SECRET",
      authorizationParams: {
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent",
      },
      fileOutput: {
        type: "authorized_user",
        relativePath: GOOGLE_VAULT_CREDENTIAL_FILES.cloudSdk.relativePath,
        targetPath: GOOGLE_VAULT_CREDENTIAL_FILES.cloudSdk.targetPath,
        envKey: "GOOGLE_APPLICATION_CREDENTIALS",
        additionalEnvKeys: ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"],
      },
    },
  ];
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function parseAccessTokenEnvKeys(
  value: Record<string, unknown>,
  index: number,
  id: string,
): string[] | undefined | null {
  const keys = [trimmedString(value.accessTokenEnvKey)];
  for (const field of ["additionalAccessTokenEnvKeys", "accessTokenEnvKeys"] as const) {
    const parsed = parseStringArray(value[field], field, index, id);
    if (parsed === null) return null;
    keys.push(...(parsed ?? []).map((key) => key.trim()));
  }
  const unique = [...new Set(keys.filter((key): key is string => !!key))];
  return unique.length > 0 ? unique : undefined;
}

function parseFileOutput(
  value: unknown,
  index: number,
  id: string,
): OAuthService["fileOutput"] | null {
  if (!isRecord(value)) return undefined;
  const additionalEnvKeys = parseStringArray(
    value.additionalEnvKeys,
    "fileOutput.additionalEnvKeys",
    index,
    id,
  );
  if (additionalEnvKeys === null) return null;
  const relativePath = trimmedString(value.relativePath);
  if (trimmedString(value.type) !== "authorized_user" || !relativePath) return undefined;
  return {
    type: "authorized_user",
    relativePath,
    targetPath: trimmedString(value.targetPath),
    envKey: trimmedString(value.envKey),
    additionalEnvKeys,
  };
}

function parseOAuthService(value: unknown, index: number): OAuthService | null {
  if (!isRecord(value)) {
    log.logWarning(`Skipping OAUTH_SERVICES_JSON[${index}]: expected an object`);
    return null;
  }

  const id = trimmedString(value.id) ?? "";
  const label = trimmedString(value.label) ?? "";
  const authorizationUrl = trimmedString(value.authorizationUrl) ?? "";
  const tokenUrl = trimmedString(value.tokenUrl) ?? "";
  const clientIdEnvKey = trimmedString(value.clientIdEnvKey) ?? "";
  const clientSecretEnvKey = trimmedString(value.clientSecretEnvKey) ?? "";
  const missing = [
    ["id", id],
    ["label", label],
    ["authorizationUrl", authorizationUrl],
    ["tokenUrl", tokenUrl],
    ["clientIdEnvKey", clientIdEnvKey],
    ["clientSecretEnvKey", clientSecretEnvKey],
  ]
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);

  if (missing.length > 0) {
    const labelForLog = id ? ` (${id})` : "";
    log.logWarning(
      `Skipping OAUTH_SERVICES_JSON[${index}]${labelForLog}: missing ${missing.join(", ")}`,
    );
    return null;
  }

  const aliases = parseStringArray(value.aliases, "aliases", index, id);
  if (aliases === null) return null;
  const scopes = parseStringArray(value.scopes, "scopes", index, id);
  if (scopes === null) return null;
  const authorizationParams = parseStringRecord(
    value.authorizationParams,
    "authorizationParams",
    index,
    id,
  );
  if (authorizationParams === null) return null;

  const accessTokenEnvKeys = parseAccessTokenEnvKeys(value, index, id);
  if (accessTokenEnvKeys === null) return null;
  const fileOutput = parseFileOutput(value.fileOutput, index, id);
  if (fileOutput === null) return null;

  return {
    id: id.toLowerCase(),
    label,
    aliases: aliases?.map((v) => v.toLowerCase()) ?? [id.toLowerCase()],
    authorizationUrl,
    tokenUrl,
    scopes: scopes ?? [],
    clientIdEnvKey,
    clientSecretEnvKey,
    accessTokenEnvKeys,
    refreshTokenEnvKey: trimmedString(value.refreshTokenEnvKey),
    authorizationParams: authorizationParams ?? undefined,
    fileOutput,
  };
}

function parseStringArray(
  value: unknown,
  field: string,
  index: number,
  id: string,
): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    log.logWarning(`Skipping OAUTH_SERVICES_JSON[${index}] (${id}): ${field} must be strings`);
    return null;
  }
  return value;
}

function parseStringRecord(
  value: unknown,
  field: string,
  index: number,
  id: string,
): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    log.logWarning(`Skipping OAUTH_SERVICES_JSON[${index}] (${id}): ${field} must be strings`);
    return null;
  }
  return value as Record<string, string>;
}

export function getOAuthServices(): OAuthService[] {
  const raw = readEnv("OAUTH_SERVICES_JSON");
  const builtins = getBuiltinOAuthServices();
  if (!raw) return builtins;

  let parsed: unknown[];
  try {
    parsed = parseJsonValue(raw, Array.isArray, (detail) =>
      detail === "unexpected JSON shape"
        ? "expected a JSON array of OAuth service definitions"
        : detail,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.logWarning(
      detail === "expected a JSON array of OAuth service definitions"
        ? "Ignoring OAUTH_SERVICES_JSON: expected a JSON array of OAuth service definitions"
        : "Ignoring OAUTH_SERVICES_JSON: invalid JSON",
      detail,
    );
    return builtins;
  }

  const custom = parsed
    .map((serviceValue, index) => parseOAuthService(serviceValue, index))
    .filter((service): service is OAuthService => service !== null);
  const byId = new Map([...builtins, ...custom].map((service) => [service.id, service]));
  return [...byId.values()];
}

export function resolveOAuthService(input: string): OAuthService | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  return getOAuthServices().find(
    (service) => service.id === normalized || service.aliases.includes(normalized),
  );
}
