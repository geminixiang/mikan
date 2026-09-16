import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
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

export type { AgentConfig, SandboxSettings } from "../types.js";
import type { AgentConfig, SandboxSettings } from "../types.js";
import type { McpServerConfig } from "../harness/types.js";
import type { OnboardLlmChoice } from "../types.js";
import type { Office } from "../office/index.js";

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
    // Office visibility is not a setting here: it follows the platform
    // conversation type (see office/projection resolveOfficeVisibility).
    defaultSharedVault: "",
  },
};

const SettingsFileSchema = Type.Object({
  llm: Type.Optional(
    Type.Object({
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(
        Type.Union([
          Type.Literal("off"),
          Type.Literal("minimal"),
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("xhigh"),
          Type.Literal("max"),
        ]),
      ),
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
  /**
   * Conversation-only office policy. `visibility: "private"` marks a
   * platform-public conversation as private; nothing can widen visibility
   * beyond what the platform grants, so "public" is never stored here.
   */
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
      /**
       * Retired door-policy keys (ADR 0008). Still accepted so existing files
       * load, never copied into AgentConfig, and removed by
       * `mikan office migrate-door-policy`.
       */
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
  /**
   * MCP servers, keyed by name. Merged per key across scopes: a conversation
   * entry overrides (or, with `disabled: true`, turns off) the same-name
   * global entry; other global entries stay available. `open-connector` is an
   * ordinary entry that the host fills in from `OPENCONNECTOR_ENDPOINT` when
   * neither scope declares it (see `src/harness/open-connector.ts`).
   */
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
  return readJsonSchemaFileIfExists(settingsPath, SettingsFileSchema, (detail) =>
    detail === "unexpected JSON shape"
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

/**
 * File shape → in-memory shape for the sandbox group. An empty or
 * whitespace-only `defaultSharedVault` means "no default" and is dropped;
 * non-empty values are trimmed. Everything else passes through as-is.
 */
function normalizeSandboxSettings(sandbox: SandboxFileSettings): SandboxSettings {
  const defaultSharedVault = sandbox.defaultSharedVault?.trim();
  // Retired `image.workspaceMount` and `workspace` are dropped here: office
  // visibility comes from the platform (ADR 0008), never from these keys.
  return {
    ...(sandbox.cpus !== undefined ? { cpus: sandbox.cpus } : {}),
    ...(sandbox.memory !== undefined ? { memory: sandbox.memory } : {}),
    ...(sandbox.boost !== undefined ? { boost: sandbox.boost } : {}),
    ...(defaultSharedVault ? { defaultSharedVault } : {}),
  };
}

/**
 * Merge two sandbox settings groups. The merge invariant is LEAF-LEVEL:
 * an override that only sets `sandbox.memory` keeps the base `sandbox.cpus`,
 * and an override that only sets `boost.memory` keeps the base `boost.cpus`
 * (same for `image`). This mirrors how the fields merged when they were
 * flat top-level keys; a group-level spread would silently drop base leaves.
 */
function mergeSandboxSettings(
  base: SandboxSettings | undefined,
  override: SandboxSettings | undefined,
): SandboxSettings | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    ...(base.boost || override.boost ? { boost: { ...base.boost, ...override.boost } } : {}),
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

/**
 * Host-authoritative location of a conversation's settings file:
 * `<office state dir>/settings.json`. The Office value names both the
 * state-dir key and the legacy pre-host-migration location (its workspace
 * dir) — the key is never inferred from a directory basename.
 *
 * Conversation settings used to live at `<conversationDir>/settings.json`,
 * but conversation dirs are bind-mounted read-write into sandbox containers
 * in image mode — code inside the sandbox could edit its own settings.json
 * and flip `sandbox.image.workspaceMount` to "full", remounting the entire
 * workspace into its container (cross-conversation access). Settings are an
 * administrator surface, so they live under the host-only state dir.
 *
 * Migration: on first access per conversation, a legacy
 * `<conversationDir>/settings.json` is moved here. The new file's existence
 * (an empty `{}` is written when there is nothing to migrate) is the
 * migration marker — a legacy file (re)appearing later, e.g. planted from
 * inside the sandbox, is never read again.
 */
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
    // Validate before moving the file. A malformed legacy file must fail
    // closed and remain available for an operator to repair.
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

const AUTO_REPLY_FILE = "auto-reply";
const AUTO_REPLY_DISABLED_FILE = "auto-reply.disabled";

export function slackConversationAutoReplyEnabled(office: Office): boolean {
  return existsSync(join(office.dir, AUTO_REPLY_FILE));
}

export function setSlackConversationAutoReply(office: Office, enabled: boolean): void {
  ensureDirExists(office.dir);
  const enabledPath = join(office.dir, AUTO_REPLY_FILE);
  const disabledPath = join(office.dir, AUTO_REPLY_DISABLED_FILE);
  const targetPath = enabled ? enabledPath : disabledPath;
  const otherPath = enabled ? disabledPath : enabledPath;

  if (existsSync(otherPath)) {
    renameSync(otherPath, targetPath);
    return;
  }
  if (enabled && !existsSync(targetPath)) {
    atomicWritePrivateFile(targetPath, "");
  }
}

export function resolveConversationSettings(office: Office): AgentConfig {
  const globalConfig = loadRawGlobalSettings();
  const conversationConfig = normalizeSettingsConfig(
    loadSettingsFile(conversationSettingsPath(office)) ?? {},
  );
  // MCP servers merge per key: a conversation redefines or disables individual
  // servers without losing the rest of the global set.
  const mcpServers = { ...globalConfig.mcpServers, ...conversationConfig.mcpServers };
  // The sandbox group merges at the leaf level (see mergeSandboxSettings):
  // a conversation that only sets sandbox.memory keeps the global sandbox.cpus.
  const sandbox = mergeSandboxSettings(globalConfig.sandbox, conversationConfig.sandbox);
  return toAgentConfig({
    ...globalConfig,
    ...conversationConfig,
    ...(sandbox ? { sandbox } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
  });
}

/** Settings-file DSN wins over SENTRY_DSN env — the rule lives only here. */
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
    ...(hasDefinedValue(config.llm) ? { llm: config.llm } : {}),
    ...(hasDefinedValue(config.sentry) ? { sentry: config.sentry } : {}),
    ...(hasDefinedValue(config.sandbox) ? { sandbox: config.sandbox } : {}),
    ...(hasDefinedValue(config.slack) ? { slack: config.slack } : {}),
    ...(hasDefinedValue(config.office) ? { office: config.office } : {}),
    // An empty map means "all servers removed".
    ...(config.mcpServers !== undefined ? { mcpServers: config.mcpServers } : {}),
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
    // Leaf-level merge: a patch that only sets sandbox.boost.memory keeps the
    // existing boost.cpus (and every other existing leaf). compactSettingsConfig
    // drops the group entirely when it ends up with no defined values.
    sandbox: mergeSandboxSettings(existing.sandbox, config.sandbox) ?? {},
    slack: {
      ...existing.slack,
      ...config.slack,
    },
    // Office visibility has its own writer (setOfficeVisibilityOverride); the
    // generic patch must not drop it.
    ...(existing.office !== undefined ? { office: existing.office } : {}),
    // The portal edits the full MCP map, and
    // a merge would make removing a server impossible.
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
    const detail = err instanceof Error ? err.message : String(err);
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

/**
 * The two scope-level MCP server maps, unmerged: the portal edits each scope's
 * own file, so it needs the raw per-scope values, not the effective merge
 * (`resolveConversationSettings` owns that).
 */
export function loadScopeMcpServers(office: Office): {
  global: Record<string, McpServerConfig>;
  conversation: Record<string, McpServerConfig>;
} {
  return {
    global: loadRawGlobalSettings().mcpServers ?? {},
    conversation: loadSettingsFile(conversationSettingsPath(office))?.mcpServers ?? {},
  };
}

/**
 * The conversation's own visibility override, or null when it follows the
 * platform. Only "private" can be stored: an operator may narrow a public
 * channel, never widen a private one (see ADR 0008).
 */
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
      compactSettingsConfig({ ...rest, ...(visibility ? { office: { visibility } } : {}) }),
      null,
      2,
    ),
  );
}
