import { matchCommand } from "../../commands/parse.js";
import { readEnv } from "../../utils/env.js";
import { isRecord, parseJsonValue } from "../../utils/file-guards.js";
import * as log from "../../log.js";

export type { LoginCredentialKind, OAuthService, ParsedLoginCommand } from "./types.js";
import type { LoginCredentialKind, OAuthService, ParsedLoginCommand } from "./types.js";

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

// Conservative default: enough for `gh` CLI repo/user/org operations, but
// without `workflow` (can dispatch CI), `write:packages` (can publish
// packages), or `project`. Operators who need those can opt in via
// GITHUB_OAUTH_SCOPES (or MIKAN_GITHUB_OAUTH_SCOPES) to keep the blast radius
// of a compromised agent host explicit and configurable.
const DEFAULT_GITHUB_OAUTH_SCOPES = ["repo", "read:user", "user:email", "read:org", "gist"];

function resolveScopesFromEnv(envKey: string, fallback: string[]): string[] {
  const raw = readEnv(envKey);
  if (!raw) return fallback;

  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

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
        relativePath: "gws.json",
        targetPath: "/root/.config/gws/credentials.json",
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
        relativePath: "gcloud-adc.json",
        targetPath: "/root/.config/gcloud/application_default_credentials.json",
        envKey: "GOOGLE_APPLICATION_CREDENTIALS",
        additionalEnvKeys: ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"],
      },
    },
  ];
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
  try {
    const custom = parsed
      .map((serviceValue): OAuthService | null => {
        if (!isRecord(serviceValue)) return null;
        const obj = serviceValue;
        const id = typeof obj.id === "string" ? obj.id.trim() : "";
        const label = typeof obj.label === "string" ? obj.label.trim() : "";
        const authorizationUrl =
          typeof obj.authorizationUrl === "string" ? obj.authorizationUrl.trim() : "";
        const tokenUrl = typeof obj.tokenUrl === "string" ? obj.tokenUrl.trim() : "";
        const clientIdEnvKey =
          typeof obj.clientIdEnvKey === "string" ? obj.clientIdEnvKey.trim() : "";
        const clientSecretEnvKey =
          typeof obj.clientSecretEnvKey === "string" ? obj.clientSecretEnvKey.trim() : "";
        const accessTokenEnvKeys: string[] = [];
        if (typeof obj.accessTokenEnvKey === "string" && obj.accessTokenEnvKey.trim()) {
          accessTokenEnvKeys.push(obj.accessTokenEnvKey.trim());
        }
        if (Array.isArray(obj.additionalAccessTokenEnvKeys)) {
          for (const k of obj.additionalAccessTokenEnvKeys) {
            if (typeof k === "string" && k.trim()) accessTokenEnvKeys.push(k.trim());
          }
        }
        // New unified form
        if (Array.isArray(obj.accessTokenEnvKeys)) {
          for (const k of obj.accessTokenEnvKeys) {
            if (typeof k === "string" && k.trim() && !accessTokenEnvKeys.includes(k.trim())) {
              accessTokenEnvKeys.push(k.trim());
            }
          }
        }
        if (
          !id ||
          !label ||
          !authorizationUrl ||
          !tokenUrl ||
          !clientIdEnvKey ||
          !clientSecretEnvKey
        ) {
          return null;
        }

        let fileOutput: OAuthService["fileOutput"];
        if (isRecord(obj.fileOutput)) {
          const fileOutputObj = obj.fileOutput;
          const type = typeof fileOutputObj.type === "string" ? fileOutputObj.type.trim() : "";
          const relativePath =
            typeof fileOutputObj.relativePath === "string" ? fileOutputObj.relativePath.trim() : "";
          const targetPath =
            typeof fileOutputObj.targetPath === "string"
              ? fileOutputObj.targetPath.trim()
              : undefined;
          const envKey =
            typeof fileOutputObj.envKey === "string" ? fileOutputObj.envKey.trim() : undefined;
          const additionalEnvKeys = Array.isArray(fileOutputObj.additionalEnvKeys)
            ? fileOutputObj.additionalEnvKeys.filter((v): v is string => typeof v === "string")
            : undefined;
          if (type === "authorized_user" && relativePath) {
            fileOutput = {
              type: "authorized_user",
              relativePath,
              targetPath,
              envKey,
              additionalEnvKeys,
            };
          }
        }

        return {
          id: id.toLowerCase(),
          label,
          aliases: Array.isArray(obj.aliases)
            ? obj.aliases
                .filter((v): v is string => typeof v === "string")
                .map((v) => v.toLowerCase())
            : [id.toLowerCase()],
          authorizationUrl,
          tokenUrl,
          scopes: Array.isArray(obj.scopes)
            ? obj.scopes.filter((v): v is string => typeof v === "string")
            : [],
          clientIdEnvKey,
          clientSecretEnvKey,
          accessTokenEnvKeys: accessTokenEnvKeys.length > 0 ? accessTokenEnvKeys : undefined,
          refreshTokenEnvKey:
            typeof obj.refreshTokenEnvKey === "string" ? obj.refreshTokenEnvKey.trim() : undefined,
          authorizationParams: isRecord(obj.authorizationParams)
            ? Object.fromEntries(
                Object.entries(obj.authorizationParams).filter(
                  (authorizationEntry): authorizationEntry is [string, string] =>
                    typeof authorizationEntry[1] === "string",
                ),
              )
            : undefined,
          fileOutput,
        };
      })
      .filter((service): service is OAuthService => service !== null);

    const byId = new Map<string, OAuthService>();
    for (const service of builtins) byId.set(service.id, service);
    for (const service of custom) byId.set(service.id, service);
    return [...byId.values()];
  } catch (err) {
    log.logWarning(
      "Failed to apply OAUTH_SERVICES_JSON overrides; using builtin OAuth services",
      err instanceof Error ? err.message : String(err),
    );
    return builtins;
  }
}

export function resolveOAuthService(input: string): OAuthService | undefined {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return undefined;
  return getOAuthServices().find(
    (service) => service.id === normalized || service.aliases.includes(normalized),
  );
}

const LOGIN_COMMANDS = ["login", "/login", "/pi-login"] as const;

export function parseLoginCommand(text: string): ParsedLoginCommand | null {
  const matched = matchCommand(text, LOGIN_COMMANDS);
  if (!matched) return null;

  const [subcommand, operation, name, ...extra] = matched.args;

  if (!subcommand) return { action: "setup" };

  if (subcommand.toLowerCase() === "shared") {
    const op = operation?.toLowerCase();
    if (op === "list" && !name && extra.length === 0) {
      return { action: "shared_list" };
    }
    if ((op === "create" || op === "update" || op === "delete") && !!name && extra.length === 0) {
      return {
        action: `shared_${op}` as "shared_create" | "shared_update" | "shared_delete",
        name,
      };
    }
    return null;
  }

  if (subcommand.toLowerCase() === "copy" && operation && !name && extra.length === 0) {
    return { action: "copy_shared", name: operation };
  }

  // Backward-compatible: older `/pi-login gh` / `/pi-login gws` forms opened the
  // generic login page and let the portal handle provider choice.
  if (!operation && extra.length === 0) return { action: "setup" };

  return null;
}
