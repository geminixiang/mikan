import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { effectiveStateDir } from "../cli/arg-grammar.js";
import { readEnv } from "../env-manifest.js";
import {
  atomicWritePrivateFile,
  ensureDirExists,
  readJsonSchemaFileIfExists,
} from "../file-guards.js";
import * as log from "../log.js";

export class MissingGlobalSettingsError extends Error {
  constructor(public readonly settingsPath: string) {
    super(`Missing global settings file at ${settingsPath}`);
    this.name = "MissingGlobalSettingsError";
  }
}

import type { AgentConfig, SandboxSettings } from "../types.js";
import type { McpServerConfig } from "../harness/types.js";
import type { OnboardLlmChoice } from "../types.js";
import type { Office } from "../office/types.js";
import { errorMessage } from "../unknown-values.js";

const ONBOARD_SETTINGS: SettingsFileConfig = {
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinkingLevel: "off",
  },
  slack: {
    replyMode: "top-level",
  },
  sandbox: {
    cpus: "0.5",
    memory: "1g",
    boost: {
      cpus: "2",
      memory: "4g",
    },
    defaultSharedVault: "",
  },
};

const THINKING_LEVEL_KEYS: Record<ThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_KEYS) as ThinkingLevel[];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && Object.hasOwn(THINKING_LEVEL_KEYS, value);
}

const SettingsFileSchema = Type.Object({
  llm: Type.Optional(
    Type.Object({
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
    }),
  ),
  sentry: Type.Optional(
    Type.Object({
      dsn: Type.Optional(Type.String()),
    }),
  ),
  slack: Type.Optional(
    Type.Object({
      replyMode: Type.Optional(Type.Union([Type.Literal("top-level"), Type.Literal("thread")])),
    }),
  ),
  office: Type.Optional(
    Type.Object({
      visibility: Type.Optional(Type.Literal("private")),
    }),
  ),
  sandbox: Type.Optional(
    Type.Object({
      cpus: Type.Optional(Type.String()),
      memory: Type.Optional(Type.String()),
      boost: Type.Optional(
        Type.Object({
          cpus: Type.Optional(Type.String()),
          memory: Type.Optional(Type.String()),
        }),
      ),
      image: Type.Optional(
        Type.Object({
          workspaceMount: Type.Optional(
            Type.Union([Type.Literal("private"), Type.Literal("full")]),
          ),
        }),
      ),
      workspace: Type.Optional(
        Type.Object({
          doorPolicy: Type.Optional(
            Type.Union([Type.Literal("isolated"), Type.Literal("trusted")]),
          ),
          layout: Type.Optional(
            Type.Union([
              Type.Literal("conversation"),
              Type.Literal("shared-support"),
              Type.Literal("full"),
            ]),
          ),
          visibility: Type.Optional(Type.Union([Type.Literal("public"), Type.Literal("private")])),
        }),
      ),
      defaultSharedVault: Type.Optional(Type.String()),
    }),
  ),
  mcpServers: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        command: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(Type.String())),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        url: Type.Optional(Type.String()),
        headers: Type.Optional(Type.Record(Type.String(), Type.String())),
        disabled: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
});

export type SettingsFileConfig = Static<typeof SettingsFileSchema>;
export type SandboxFileSettings = NonNullable<SettingsFileConfig["sandbox"]>;

export function loadSettingsFile(settingsPath: string): SettingsFileConfig | undefined {
  return readJsonSchemaFileIfExists(settingsPath, SettingsFileSchema, (detail, kind) =>
    kind === "shape"
      ? `Malformed settings file at ${settingsPath}: expected a JSON object at the top level`
      : `Malformed settings file at ${settingsPath}: ${detail}`,
  );
}

function normalizeSettingsConfig(config: SettingsFileConfig): Partial<AgentConfig> {
  return {
    ...(config.llm?.provider !== undefined ? { provider: config.llm.provider } : {}),
    ...(config.llm?.model !== undefined ? { model: config.llm.model } : {}),
    ...(config.llm?.thinkingLevel !== undefined ? { thinkingLevel: config.llm.thinkingLevel } : {}),
    ...(config.sentry?.dsn !== undefined ? { sentryDsn: config.sentry.dsn } : {}),
    ...(config.sandbox !== undefined ? { sandbox: normalizeSandboxSettings(config.sandbox) } : {}),
    ...(config.slack !== undefined ? { slack: config.slack } : {}),
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
  };
}

function normalizeSandboxSettings(sandbox: SandboxFileSettings): SandboxSettings {
  const defaultSharedVault = sandbox.defaultSharedVault?.trim();
  return {
    ...(sandbox.cpus !== undefined ? { cpus: sandbox.cpus } : {}),
    ...(sandbox.memory !== undefined ? { memory: sandbox.memory } : {}),
    ...(sandbox.boost !== undefined ? { boost: sandbox.boost } : {}),
    ...(defaultSharedVault ? { defaultSharedVault } : {}),
  };
}

function mergeSandboxSettings(
  base: SandboxSettings | undefined,
  override: SandboxSettings | undefined,
): SandboxSettings | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    boost: base.boost || override.boost ? { ...base.boost, ...override.boost } : undefined,
  };
}

function getSettingsPath(): string {
  return join(effectiveStateDir(), "settings.json");
}

function requireGlobalSettings(): SettingsFileConfig {
  const settingsPath = getSettingsPath();
  const config = loadSettingsFile(settingsPath);
  if (!config) {
    throw new MissingGlobalSettingsError(settingsPath);
  }
  return config;
}

function requireString(value: string | undefined, path: string): string {
  if (!value) {
    throw new Error(
      `Missing required global setting: ${path}. Run \`mikan --onboard\` to create settings.json.`,
    );
  }
  return value;
}

function toAgentConfig(fromFile: Partial<AgentConfig>): AgentConfig {
  const provider = requireString(fromFile.provider, "llm.provider");
  const model = requireString(fromFile.model, "llm.model");
  const thinkingLevel = requireString(fromFile.thinkingLevel, "llm.thinkingLevel") as ThinkingLevel;
  const sentryDsn = sentryDsnFrom(fromFile.sentryDsn);
  const sandbox = fromFile.sandbox;
  const slack = fromFile.slack;
  const mcpServers = fromFile.mcpServers;

  return {
    provider,
    model,
    thinkingLevel,
    sentryDsn,
    sandbox,
    slack,
    mcpServers,
  };
}

function loadRawGlobalSettings(): Partial<AgentConfig> {
  return normalizeSettingsConfig(requireGlobalSettings());
}

export function loadGlobalSettings(): AgentConfig {
  return toAgentConfig(loadRawGlobalSettings());
}

export function conversationSettingsPath(office: Office): string {
  const hostPath = join(office.stateDir, "settings.json");
  if (existsSync(hostPath)) {
    assertSettingsFile(hostPath, "Host conversation settings");
    return hostPath;
  }

  ensureDirExists(dirname(hostPath));
  const legacyPath = join(office.dir, "settings.json");
  let content = "{}\n";
  let migrated = false;
  if (existsSync(legacyPath)) {
    assertSettingsFile(legacyPath, "Legacy conversation settings");
    content = readFileSync(legacyPath, "utf-8");
    loadSettingsFile(legacyPath);
    migrated = true;
  }
  atomicWritePrivateFile(hostPath, content);
  if (migrated) {
    try {
      rmSync(legacyPath);
    } catch (err) {
      log.logWarning(`Could not remove legacy conversation settings: ${legacyPath}`, String(err));
    }
    log.logInfo(`Migrated conversation settings to host-only path: ${hostPath}`);
  }
  return hostPath;
}

function assertSettingsFile(path: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (err) {
    throw new Error(`${label} cannot be inspected: ${path}`, { cause: err });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

export type SlackAutoReplyMode = "off" | "on" | "jev";

const AUTO_REPLY_FILE = "auto-reply";
const AUTO_REPLY_JEV_FILE = "auto-reply.jev";
const AUTO_REPLY_MARKERS: Record<Exclude<SlackAutoReplyMode, "off">, string> = {
  on: AUTO_REPLY_FILE,
  jev: AUTO_REPLY_JEV_FILE,
};

export function slackConversationAutoReplyMode(office: Office): SlackAutoReplyMode {
  if (existsSync(join(office.dir, AUTO_REPLY_JEV_FILE))) return "jev";
  if (existsSync(join(office.dir, AUTO_REPLY_FILE))) return "on";
  return "off";
}

export function setSlackConversationAutoReply(office: Office, mode: SlackAutoReplyMode): void {
  ensureDirExists(office.dir);
  for (const [markerMode, fileName] of Object.entries(AUTO_REPLY_MARKERS)) {
    const path = join(office.dir, fileName);
    if (markerMode === mode) {
      if (!existsSync(path)) atomicWritePrivateFile(path, "");
    } else if (existsSync(path)) {
      rmSync(path);
    }
  }
}

export function resolveConversationSettings(office: Office): AgentConfig {
  const globalConfig = loadRawGlobalSettings();
  const conversationConfig = normalizeSettingsConfig(
    loadSettingsFile(conversationSettingsPath(office)) ?? {},
  );
  const mcpServers = { ...globalConfig.mcpServers, ...conversationConfig.mcpServers };
  const sandbox = mergeSandboxSettings(globalConfig.sandbox, conversationConfig.sandbox);
  return toAgentConfig({
    ...globalConfig,
    ...conversationConfig,
    sandbox,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  });
}

function sentryDsnFrom(fromFile: string | undefined): string | undefined {
  return fromFile || readEnv("SENTRY_DSN");
}

export function resolveSentryDsn(): string | undefined {
  const fromFile = normalizeSettingsConfig(loadSettingsFile(getSettingsPath()) ?? {});
  return sentryDsnFrom(fromFile.sentryDsn);
}

export function createGlobalSettingsFile(stateDir: string, llm?: OnboardLlmChoice): string {
  const settingsPath = join(stateDir, "settings.json");
  if (existsSync(settingsPath)) {
    throw new Error(`Global settings already exists at ${settingsPath}`);
  }
  ensureDirExists(stateDir);
  const settings: SettingsFileConfig = llm
    ? {
        ...ONBOARD_SETTINGS,
        llm: {
          ...ONBOARD_SETTINGS.llm,
          provider: llm.provider,
          model: llm.model,
        },
      }
    : ONBOARD_SETTINGS;
  atomicWritePrivateFile(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}

export function hasDefinedValue(values: Record<string, unknown> | undefined): boolean {
  return values !== undefined && Object.values(values).some((value) => value !== undefined);
}

export function compactSettingsConfig(config: SettingsFileConfig): SettingsFileConfig {
  return {
    llm: hasDefinedValue(config.llm) ? config.llm : undefined,
    sentry: hasDefinedValue(config.sentry) ? config.sentry : undefined,
    sandbox: hasDefinedValue(config.sandbox) ? config.sandbox : undefined,
    slack: hasDefinedValue(config.slack) ? config.slack : undefined,
    office: hasDefinedValue(config.office) ? config.office : undefined,
    mcpServers: config.mcpServers,
  };
}

function patchSettingsConfig(
  existing: SettingsFileConfig,
  config: Partial<AgentConfig>,
): SettingsFileConfig {
  const patched: SettingsFileConfig = {
    ...existing,
    llm: {
      ...existing.llm,
      ...(config.provider !== undefined ? { provider: config.provider } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
    },
    sentry: {
      ...existing.sentry,
      ...(config.sentryDsn !== undefined ? { dsn: config.sentryDsn } : {}),
    },
    sandbox: mergeSandboxSettings(existing.sandbox, config.sandbox) ?? {},
    slack: {
      ...existing.slack,
      ...config.slack,
    },
    office: existing.office,
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
  };
  return compactSettingsConfig(patched);
}

function loadSettingsFileForUpdate(
  settingsPath: string,
  defaultSettings: SettingsFileConfig,
): SettingsFileConfig {
  if (!existsSync(settingsPath)) return defaultSettings;
  try {
    return loadSettingsFile(settingsPath) ?? {};
  } catch (err) {
    const detail = errorMessage(err);
    const message = detail.startsWith("Malformed settings file")
      ? detail.replace("Malformed settings file", "Refusing to overwrite malformed settings file")
      : detail;
    throw new Error(message, { cause: err });
  }
}

function updateSettingsFile(
  settingsPath: string,
  patch: Partial<AgentConfig>,
  defaultSettings: SettingsFileConfig,
): void {
  const existing = loadSettingsFileForUpdate(settingsPath, defaultSettings);
  ensureDirExists(dirname(settingsPath));
  atomicWritePrivateFile(
    settingsPath,
    JSON.stringify(patchSettingsConfig(existing, patch), null, 2),
  );
}

export function updateGlobalSettings(patch: Partial<AgentConfig>): void {
  updateSettingsFile(getSettingsPath(), patch, ONBOARD_SETTINGS);
}

export function updateConversationSettings(office: Office, patch: Partial<AgentConfig>): void {
  updateSettingsFile(conversationSettingsPath(office), patch, {});
}

export function loadScopeMcpServers(office: Office): {
  global: Record<string, McpServerConfig>;
  conversation: Record<string, McpServerConfig>;
} {
  return {
    global: loadRawGlobalSettings().mcpServers ?? {},
    conversation: loadSettingsFile(conversationSettingsPath(office))?.mcpServers ?? {},
  };
}

export function loadOfficeVisibilityOverride(office: Office): "private" | null {
  return loadSettingsFile(conversationSettingsPath(office))?.office?.visibility ?? null;
}

export function setOfficeVisibilityOverride(office: Office, visibility: "private" | null): void {
  const settingsPath = conversationSettingsPath(office);
  const existing = loadSettingsFileForUpdate(settingsPath, {});
  const { office: _previous, ...rest } = existing;
  ensureDirExists(dirname(settingsPath));
  atomicWritePrivateFile(
    settingsPath,
    JSON.stringify(
      compactSettingsConfig({ ...rest, office: visibility ? { visibility } : undefined }),
      null,
      2,
    ),
  );
}
