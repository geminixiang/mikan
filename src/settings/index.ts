import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnv } from "../env-manifest.js";
import {
  atomicWritePrivateFile,
  ensureDirExists,
  ensurePrivateDirExists,
  readJsonSchemaFileIfExists,
} from "../file-guards.js";

export class MissingGlobalSettingsError extends Error {
  constructor(public readonly settingsPath: string) {
    super(`Missing global settings file at ${settingsPath}`);
    this.name = "MissingGlobalSettingsError";
  }
}

import type { AgentConfig, SandboxSettings } from "../types.js";
import type { McpServerConfig, SkillPatterns } from "../harness/types.js";
import type { OnboardLlmChoice } from "../types.js";
import type { Office } from "../office/types.js";
import { errorMessage, isRecord } from "../unknown-values.js";

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
      thinkingLevel: Type.Optional(Type.Enum(THINKING_LEVELS)),
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
        exposure: Type.Optional(Type.Union([Type.Literal("codemode"), Type.Literal("deferred")])),
        description: Type.Optional(Type.String()),
      }),
    ),
  ),
  skills: Type.Optional(Type.Array(Type.String({ pattern: "^[!+-]." }))),
});

type SettingsFileConfig = Static<typeof SettingsFileSchema>;
type SandboxFileSettings = NonNullable<SettingsFileConfig["sandbox"]>;

function loadSettingsFile(settingsPath: string): SettingsFileConfig | undefined {
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

function unusedKeys(value: unknown, used: unknown, prefix: string): string[] {
  if (!isRecord(value) || !isRecord(used)) return [];
  return Object.keys(value).flatMap((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return Object.hasOwn(used, key) ? unusedKeys(value[key], used[key], path) : [path];
  });
}

function unusedSettingsKeys(settingsPath: string): string[] {
  let settings: SettingsFileConfig | undefined;
  try {
    settings = loadSettingsFile(settingsPath);
  } catch {
    return [];
  }
  return unusedKeys(settings, Value.Clean(SettingsFileSchema, structuredClone(settings)), "");
}

export interface UnusedSettings {
  readonly path: string;
  readonly keys: readonly string[];
}

export function findUnusedSettings(stateDir: string, offices: readonly Office[]): UnusedSettings[] {
  const paths = [
    globalSettingsPath(stateDir),
    ...offices.map((office) => join(office.stateDir, "settings.json")),
  ];
  return paths.flatMap((path) => {
    const keys = unusedSettingsKeys(path);
    return keys.length > 0 ? [{ path, keys }] : [];
  });
}

export function globalSettingsPath(stateDir: string): string {
  return join(stateDir, "settings.json");
}

function requireGlobalSettings(stateDir: string): SettingsFileConfig {
  const settingsPath = globalSettingsPath(stateDir);
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

function loadRawGlobalSettings(stateDir: string): Partial<AgentConfig> {
  return normalizeSettingsConfig(requireGlobalSettings(stateDir));
}

export function loadGlobalSettings(stateDir: string): AgentConfig {
  return toAgentConfig(loadRawGlobalSettings(stateDir));
}

export function conversationSettingsPath(office: Office): string {
  const hostPath = join(office.stateDir, "settings.json");
  if (existsSync(hostPath)) {
    assertSettingsFile(hostPath, "Conversation settings");
    return hostPath;
  }
  ensurePrivateDirExists(dirname(hostPath));
  atomicWritePrivateFile(hostPath, "{}\n");
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
  const globalConfig = loadRawGlobalSettings(office.workspace.stateDir);
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

export function resolveSentryDsn(stateDir: string): string | undefined {
  const fromFile = normalizeSettingsConfig(loadSettingsFile(globalSettingsPath(stateDir)) ?? {});
  return sentryDsnFrom(fromFile.sentryDsn);
}

export function createGlobalSettingsFile(stateDir: string, llm?: OnboardLlmChoice): string {
  const settingsPath = globalSettingsPath(stateDir);
  if (existsSync(settingsPath)) {
    throw new Error(`Global settings already exists at ${settingsPath}`);
  }
  ensurePrivateDirExists(stateDir);
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

function hasDefinedValue(values: Record<string, unknown> | undefined): boolean {
  return values !== undefined && Object.values(values).some((value) => value !== undefined);
}

function compactSettingsConfig(config: SettingsFileConfig): SettingsFileConfig {
  return {
    llm: hasDefinedValue(config.llm) ? config.llm : undefined,
    sentry: hasDefinedValue(config.sentry) ? config.sentry : undefined,
    sandbox: hasDefinedValue(config.sandbox) ? config.sandbox : undefined,
    slack: hasDefinedValue(config.slack) ? config.slack : undefined,
    office: hasDefinedValue(config.office) ? config.office : undefined,
    mcpServers: config.mcpServers,
    skills: config.skills,
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
  ensurePrivateDirExists(dirname(settingsPath));
  atomicWritePrivateFile(
    settingsPath,
    JSON.stringify(patchSettingsConfig(existing, patch), null, 2),
  );
}

export function updateGlobalSettings(stateDir: string, patch: Partial<AgentConfig>): void {
  updateSettingsFile(globalSettingsPath(stateDir), patch, ONBOARD_SETTINGS);
}

export function updateConversationSettings(office: Office, patch: Partial<AgentConfig>): void {
  updateSettingsFile(conversationSettingsPath(office), patch, {});
}

export function loadSkillPatterns(office: Office): SkillPatterns {
  return {
    global: loadSettingsFile(globalSettingsPath(office.workspace.stateDir))?.skills ?? [],
    conversation: loadSettingsFile(conversationSettingsPath(office))?.skills ?? [],
  };
}

export function updateSkillPatterns(
  office: Office,
  scope: keyof SkillPatterns,
  skills: readonly string[],
): void {
  const settingsPath =
    scope === "conversation"
      ? conversationSettingsPath(office)
      : globalSettingsPath(office.workspace.stateDir);
  const existing = loadSettingsFileForUpdate(
    settingsPath,
    scope === "conversation" ? {} : ONBOARD_SETTINGS,
  );
  ensurePrivateDirExists(dirname(settingsPath));
  atomicWritePrivateFile(
    settingsPath,
    JSON.stringify(
      compactSettingsConfig({ ...existing, skills: skills.length > 0 ? [...skills] : undefined }),
      null,
      2,
    ),
  );
}

export function loadScopeMcpServers(office: Office): {
  global: Record<string, McpServerConfig>;
  conversation: Record<string, McpServerConfig>;
} {
  return {
    global: loadRawGlobalSettings(office.workspace.stateDir).mcpServers ?? {},
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
  ensurePrivateDirExists(dirname(settingsPath));
  atomicWritePrivateFile(
    settingsPath,
    JSON.stringify(
      compactSettingsConfig({ ...rest, office: visibility ? { visibility } : undefined }),
      null,
      2,
    ),
  );
}
