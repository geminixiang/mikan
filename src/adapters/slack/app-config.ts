import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { COMMAND_MANIFEST } from "../commands/manifest.js";
import { atomicWritePrivateFile, readJsonSchemaFileIfExists } from "../../file-guards.js";
import { errorMessage, isRecord } from "../../unknown-values.js";
import type {
  SlackAppApi,
  SlackAppCustomization,
  SlackAppManifest,
  SlackAppSyncResult,
  SlackBotApi,
  SlackConfigTokens,
} from "./types.js";

export const SLACK_APP_CUSTOMIZATION_FILE = "slack.json";
export const SLACK_CONFIG_TOKEN_FILE = "slack-config-token.json";

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "reactions:write",
  "users:read",
] as const;

const BOT_EVENTS = [
  "app_home_opened",
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
] as const;

const SlackAppCustomizationSchema = Type.Object(
  {
    display_information: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 35 })),
          description: Type.Optional(Type.String({ maxLength: 140 })),
          long_description: Type.Optional(Type.String({ maxLength: 4000 })),
          background_color: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const ConfigTokenFileSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
  refresh_token: Type.String({ minLength: 1 }),
});

const DEFAULT_BOT_NAME = "mikan";
const SLACK_BOT_NAME = /^[A-Za-z0-9 ._-]{1,80}$/;

export function slackBotNameProblem(name: string): string | undefined {
  return SLACK_BOT_NAME.test(name)
    ? undefined
    : `Slack names the bot user only with letters, digits, spaces, ".", "_", and "-" (up to 80), so the bot keeps the name ${DEFAULT_BOT_NAME}.`;
}

function botName(customization: SlackAppCustomization): string {
  const name = customization.display_information?.name;
  return name !== undefined && slackBotNameProblem(name) === undefined ? name : DEFAULT_BOT_NAME;
}

export function slackAppManifest(customization: SlackAppCustomization = {}): SlackAppManifest {
  const manifest = {
    display_information: {
      name: "mikan",
      description: "mikan Slack assistant",
      background_color: "#4d5673",
      ...customization.display_information,
    },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: botName(customization), always_online: true },
      slash_commands: COMMAND_MANIFEST.flatMap((entry) =>
        entry.slackCommand
          ? [
              {
                command: entry.slackCommand,
                description: entry.description,
                usage_hint: entry.arg?.description,
                should_escape: false,
              },
            ]
          : [],
      ),
    },
    oauth_config: {
      redirect_urls: ["https://localhost"],
      scopes: { bot: [...BOT_SCOPES] },
      pkce_enabled: false,
    },
    settings: {
      event_subscriptions: { bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      app_level_token_rotation_enabled: false,
      is_mcp_enabled: false,
    },
  };
  return manifest;
}

export function readSlackAppCustomization(stateDir: string): SlackAppCustomization {
  const path = join(stateDir, SLACK_APP_CUSTOMIZATION_FILE);
  return (
    readJsonSchemaFileIfExists(
      path,
      SlackAppCustomizationSchema,
      (detail) => `Invalid ${path}: ${detail}. It may hold only display_information fields.`,
    ) ?? {}
  );
}

export function slackAppCustomizationProblem(
  customization: SlackAppCustomization,
): string | undefined {
  if (Value.Check(SlackAppCustomizationSchema, customization)) return undefined;
  const first = Value.Errors(SlackAppCustomizationSchema, customization)[0];
  return `Slack would reject this app setting: ${first?.instancePath ?? ""} ${first?.message ?? ""}`.trim();
}

export function writeSlackAppCustomization(
  stateDir: string,
  customization: SlackAppCustomization,
): void {
  const problem = slackAppCustomizationProblem(customization);
  if (problem) throw new Error(problem);
  atomicWritePrivateFile(
    join(stateDir, SLACK_APP_CUSTOMIZATION_FILE),
    `${JSON.stringify(customization, null, 2)}\n`,
  );
}

function readConfigTokens(stateDir: string): SlackConfigTokens | undefined {
  const path = join(stateDir, SLACK_CONFIG_TOKEN_FILE);
  const stored = readJsonSchemaFileIfExists(
    path,
    ConfigTokenFileSchema,
    (detail) => `Invalid ${path}: ${detail}`,
  );
  return stored ? { token: stored.token, refreshToken: stored.refresh_token } : undefined;
}

export function writeConfigTokens(stateDir: string, tokens: SlackConfigTokens): void {
  atomicWritePrivateFile(
    join(stateDir, SLACK_CONFIG_TOKEN_FILE),
    `${JSON.stringify({ token: tokens.token, refresh_token: tokens.refreshToken })}\n`,
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
}

const SLACK_MANAGED_APP_HOME_FIELDS = new Set(["agent_tasks_enabled"]);

function withoutSlackManagedFields(live: unknown): unknown {
  if (!isRecord(live) || !isRecord(live.features) || !isRecord(live.features.app_home)) return live;
  const appHome = Object.fromEntries(
    Object.entries(live.features.app_home).filter(
      ([key]) => !SLACK_MANAGED_APP_HOME_FIELDS.has(key),
    ),
  );
  return { ...live, features: { ...live.features, app_home: appHome } };
}

function sameManifest(live: unknown, desired: SlackAppManifest): boolean {
  return (
    JSON.stringify(canonical(withoutSlackManagedFields(live))) ===
    JSON.stringify(canonical(desired))
  );
}

function reinstallMessage(appId: string, missingScopes: string[]): string {
  return `mikan updated this Slack app, and it now needs permissions the installed bot does not have: ${missingScopes.join(", ")}. Reinstall the app to grant them: https://api.slack.com/apps/${appId}/install-on-team`;
}

export async function syncSlackApp(options: {
  stateDir: string;
  apps: SlackAppApi;
  bot: SlackBotApi;
}): Promise<SlackAppSyncResult> {
  const { stateDir, apps, bot } = options;
  const stored = readConfigTokens(stateDir);
  if (!stored) return { status: "no-token" };
  try {
    const rotated = await apps.rotate(stored.refreshToken);
    writeConfigTokens(stateDir, rotated);
    const appId = await bot.appId();
    const desired = slackAppManifest(readSlackAppCustomization(stateDir));
    if (sameManifest(await apps.export(rotated.token, appId), desired)) {
      return { status: "unchanged", appId };
    }
    const { permissionsUpdated } = await apps.update(rotated.token, appId, desired);
    const granted = permissionsUpdated ? new Set(await bot.scopes()) : undefined;
    const missingScopes = granted
      ? (desired.oauth_config?.scopes?.bot ?? []).filter((scope) => !granted.has(scope))
      : [];
    if (missingScopes.length > 0) {
      await bot.directMessage(rotated.userId, reinstallMessage(appId, missingScopes));
    }
    return { status: "updated", appId, missingScopes };
  } catch (error) {
    return { status: "failed", reason: errorMessage(error) };
  }
}

export function describeSlackAppSync(result: SlackAppSyncResult): string | undefined {
  switch (result.status) {
    case "no-token":
      return undefined;
    case "failed":
      return `Slack app sync failed, app left as it was: ${result.reason}`;
    case "unchanged":
      return `Slack app ${result.appId} already matches mikan's manifest`;
    case "updated":
      return result.missingScopes.length > 0
        ? `Slack app ${result.appId} updated to mikan's manifest; it needs a reinstall to grant ${result.missingScopes.join(", ")}, and the configuration token owner was asked by DM`
        : `Slack app ${result.appId} updated to mikan's manifest`;
  }
}

export async function createSlackApp(options: {
  apps: SlackAppApi;
  refreshToken: string;
  customization: SlackAppCustomization;
}): Promise<{ appId: string; installUrl: string; tokens: SlackConfigTokens }> {
  const tokens = await options.apps.rotate(options.refreshToken);
  const created = await options.apps.create(tokens.token, slackAppManifest(options.customization));
  return { ...created, tokens };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Slack did not return ${what}`);
  return value;
}

const NO_RETRIES = { retryConfig: { retries: 0 }, timeout: 15_000 };

export function slackAppApi(): SlackAppApi {
  const client = new WebClient(undefined, NO_RETRIES);
  return {
    rotate: async (refreshToken) => {
      const result = await client.tooling.tokens.rotate({ refresh_token: refreshToken });
      return {
        token: required(result.token, "a configuration token"),
        refreshToken: required(result.refresh_token, "a refresh token"),
        userId: required(result.user_id, "the token owner"),
      };
    },
    export: async (token, appId) =>
      required(
        (await client.apps.manifest.export({ token, app_id: appId })).manifest,
        "a manifest",
      ),
    update: async (token, appId, manifest) => ({
      permissionsUpdated:
        (await client.apps.manifest.update({ token, app_id: appId, manifest }))
          .permissions_updated === true,
    }),
    create: async (token, manifest) => {
      const result = await client.apps.manifest.create({ token, manifest });
      return {
        appId: required(result.app_id, "an app ID"),
        installUrl: required(result.oauth_authorize_url, "an install link"),
      };
    },
    delete: async (token, appId) => {
      await client.apps.manifest.delete({ token, app_id: appId });
    },
  };
}

export function slackBotApi(botToken: string): SlackBotApi {
  const client = new WebClient(botToken, NO_RETRIES);
  return {
    appId: async () => {
      const bot = required((await client.auth.test()).bot_id, "the bot ID");
      return required((await client.bots.info({ bot })).bot?.app_id, "the app ID");
    },
    scopes: async () => (await client.auth.test()).response_metadata?.scopes ?? [],
    directMessage: async (userId, text) => {
      await client.chat.postMessage({ channel: userId, text });
    },
  };
}
