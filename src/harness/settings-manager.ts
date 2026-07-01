import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { existsSync, readFileSync, renameSync } from "fs";
import { dirname, join, resolve } from "path";
import { getMikanDir, getSettingsPath as getMikanSettingsPath } from "./config.js";
import { readEnv } from "../utils/env.js";
import { ensureDirExists, readJsonSchemaFileIfExists } from "../utils/file-guards.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";

export class MissingGlobalSettingsError extends Error {
  constructor(public readonly settingsPath: string) {
    super(`Missing global settings file at ${settingsPath}`);
    this.name = "MissingGlobalSettingsError";
  }
}

export type { AgentConfig, AutoReplyConfig, JudgeModelConfig } from "../types.js";
import type { AgentConfig, AutoReplyConfig, JudgeModelConfig } from "../types.js";

// ponytail: ONBOARD_SETTINGS is the default config; used internally
const ONBOARD_SETTINGS: SettingsFileConfig = {
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    thinkingLevel: "off",
    autoReply: {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    },
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
    image: {
      workspaceMount: "private",
    },
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
        ]),
      ),
      autoReply: Type.Optional(
        Type.Object({
          provider: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
        }),
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
      defaultSharedVault: Type.Optional(Type.String()),
    }),
  ),
  autoReply: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      rules: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  retry: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      maxRetries: Type.Optional(Type.Number()),
      baseDelayMs: Type.Optional(Type.Number()),
    }),
  ),
  compaction: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean()),
      reserveTokens: Type.Optional(Type.Number()),
      keepRecentTokens: Type.Optional(Type.Number()),
    }),
  ),
});

type SettingsFileConfig = Static<typeof SettingsFileSchema>;

function loadSettingsFile(settingsPath: string): SettingsFileConfig | undefined {
  return readJsonSchemaFileIfExists(settingsPath, SettingsFileSchema, (detail) =>
    detail === "unexpected JSON shape"
      ? `Malformed settings file at ${settingsPath}: expected a JSON object at the top level`
      : `Malformed settings file at ${settingsPath}: ${detail}`,
  );
}

function getStateDir(): string {
  return getMikanDir();
}

function normalizeSettingsConfig(config: SettingsFileConfig): Partial<AgentConfig> {
  return {
    ...(config.llm?.provider !== undefined ? { provider: config.llm.provider } : {}),
    ...(config.llm?.model !== undefined ? { model: config.llm.model } : {}),
    ...(config.llm?.thinkingLevel !== undefined ? { thinkingLevel: config.llm.thinkingLevel } : {}),
    ...(config.sentry?.dsn !== undefined ? { sentryDsn: config.sentry.dsn } : {}),
    ...(config.sandbox?.cpus !== undefined ? { sandboxCpus: config.sandbox.cpus } : {}),
    ...(config.sandbox?.memory !== undefined ? { sandboxMemory: config.sandbox.memory } : {}),
    ...(config.sandbox?.boost?.cpus !== undefined
      ? { sandboxBoostCpus: config.sandbox.boost.cpus }
      : {}),
    ...(config.sandbox?.boost?.memory !== undefined
      ? { sandboxBoostMemory: config.sandbox.boost.memory }
      : {}),
    ...(config.sandbox?.image?.workspaceMount !== undefined
      ? { sandboxImageWorkspaceMount: config.sandbox.image.workspaceMount }
      : {}),
    ...(config.sandbox?.defaultSharedVault?.trim()
      ? { defaultSharedVault: config.sandbox.defaultSharedVault.trim() }
      : {}),
    ...(config.slack !== undefined ? { slack: config.slack } : {}),
    ...(config.retry !== undefined ? { retry: config.retry } : {}),
    ...(config.compaction !== undefined ? { compaction: config.compaction } : {}),
  };
}

function getSettingsPath(): string {
  return getMikanSettingsPath();
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

function requireThinkingLevel(value: ThinkingLevel | undefined): ThinkingLevel {
  return requireString(value, "llm.thinkingLevel") as ThinkingLevel;
}

function toAgentConfig(fromFile: Partial<AgentConfig>): AgentConfig {
  const provider = requireString(fromFile.provider, "llm.provider");
  const model = requireString(fromFile.model, "llm.model");
  const thinkingLevel = requireThinkingLevel(fromFile.thinkingLevel);
  const sentryDsn = fromFile.sentryDsn ?? process.env.SENTRY_DSN;
  const sandboxCpus = fromFile.sandboxCpus;
  const sandboxMemory = fromFile.sandboxMemory;
  const sandboxBoostCpus = fromFile.sandboxBoostCpus;
  const sandboxBoostMemory = fromFile.sandboxBoostMemory;
  const sandboxImageWorkspaceMount = fromFile.sandboxImageWorkspaceMount;
  const defaultSharedVault = fromFile.defaultSharedVault;
  const slack = fromFile.slack;
  const retry = fromFile.retry;
  const compaction = fromFile.compaction;

  return {
    provider,
    model,
    thinkingLevel,
    sentryDsn,
    sandboxCpus,
    sandboxMemory,
    sandboxBoostCpus,
    sandboxBoostMemory,
    sandboxImageWorkspaceMount,
    defaultSharedVault,
    slack,
    retry,
    compaction,
  };
}

function loadRawGlobalSettings(): Partial<AgentConfig> {
  return normalizeSettingsConfig(requireGlobalSettings());
}

export function loadGlobalSettings(): AgentConfig {
  return toAgentConfig(loadRawGlobalSettings());
}

export function resolveConversationSettings(conversationDir: string): AgentConfig {
  const globalConfig = loadRawGlobalSettings();
  const conversationConfig = normalizeSettingsConfig(
    loadSettingsFile(join(conversationDir, "settings.json")) ?? {},
  );
  return toAgentConfig({ ...globalConfig, ...conversationConfig });
}

/**
 * Resolve the model used to judge auto-reply rules. Falls back to the main
 * llm.{provider,model} when llm.autoReply is not set, so a missing override
 * keeps current behavior.
 *
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export function loadAutoReplyJudgeModel(conversationDir?: string): JudgeModelConfig {
  const global = requireGlobalSettings();
  const local = conversationDir
    ? (loadSettingsFile(join(conversationDir, "settings.json")) ?? {})
    : {};
  const merged: SettingsFileConfig["llm"] = { ...global.llm, ...local.llm };
  const judge = { ...global.llm?.autoReply, ...local.llm?.autoReply };
  const provider = requireString(judge.provider ?? merged?.provider, "llm.autoReply.provider");
  const model = requireString(judge.model ?? merged?.model, "llm.autoReply.model");
  return { provider, model };
}

const AUTO_REPLY_FILE = "auto-reply";
const AUTO_REPLY_DISABLED_FILE = "auto-reply.disabled";

function readAutoReplyRulesFile(path: string): string[] {
  const text = readFileSync(path, "utf-8").trim();
  return text ? [text] : [];
}

/**
 * Load the mom-compatible auto-reply marker file state for a conversation.
 *
 * - `auto-reply` exists: enabled; empty file means reply to any top-level message.
 * - `auto-reply.disabled` exists: disabled, preserving any rules text for re-enable.
 * - neither exists: disabled.
 *
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export function loadConversationAutoReplyConfig(conversationDir: string): AutoReplyConfig {
  const enabledPath = join(conversationDir, AUTO_REPLY_FILE);
  if (existsSync(enabledPath)) {
    return { enabled: true, rules: readAutoReplyRulesFile(enabledPath) };
  }

  const disabledPath = join(conversationDir, AUTO_REPLY_DISABLED_FILE);
  if (existsSync(disabledPath)) {
    return { enabled: false, rules: readAutoReplyRulesFile(disabledPath) };
  }

  return { enabled: false, rules: [] };
}

/**
 * Save auto-reply state using mom-compatible marker files.
 *
 * @deprecated Auto-reply is kept for compatibility while its future is undecided.
 */
export function saveConversationAutoReplyConfig(
  conversationDir: string,
  config: AutoReplyConfig,
): void {
  ensureDirExists(conversationDir);

  const enabledPath = join(conversationDir, AUTO_REPLY_FILE);
  const disabledPath = join(conversationDir, AUTO_REPLY_DISABLED_FILE);
  const targetPath = config.enabled ? enabledPath : disabledPath;
  const otherPath = config.enabled ? disabledPath : enabledPath;

  if (existsSync(otherPath)) {
    renameSync(otherPath, targetPath);
  }

  atomicWritePrivateFile(targetPath, config.rules.join("\n"));
}

export function resolveWorkspaceDirFromArgv(args = process.argv.slice(2)): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--sandbox" || arg === "--download" || arg === "--state-dir") {
      i += 1;
      continue;
    }

    if (arg === "--version" || arg === "-v" || arg === "-V" || arg === "--onboard") {
      continue;
    }

    if (
      arg.startsWith("--sandbox=") ||
      arg.startsWith("--download=") ||
      arg.startsWith("--state-dir=")
    ) {
      continue;
    }

    if (!arg.startsWith("-")) {
      return arg;
    }
  }

  return undefined;
}

export function resolveStateDirFromArgv(args = process.argv.slice(2)): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--state-dir=")) {
      return resolve(arg.slice("--state-dir=".length));
    }
    if (arg === "--state-dir") {
      return resolve(args[++i] || "");
    }
  }

  return getMikanDir();
}

export function resolveSentryDsn(): string | undefined {
  const fromFile = normalizeSettingsConfig(loadSettingsFile(getSettingsPath()) ?? {});
  if (fromFile.sentryDsn) {
    return fromFile.sentryDsn;
  }

  return process.env.SENTRY_DSN;
}

export function createGlobalSettingsFile(stateDir: string): string {
  const settingsPath = join(stateDir, "settings.json");
  if (existsSync(settingsPath)) {
    throw new Error(`Global settings already exists at ${settingsPath}`);
  }
  ensureDirExists(stateDir);
  atomicWritePrivateFile(settingsPath, JSON.stringify(ONBOARD_SETTINGS, null, 2));
  return settingsPath;
}

/**
 * Externally-visible base URL of the link/OAuth server, e.g.
 * `https://mikan.example.com` (no trailing slash). Read from `LINK_URL` or
 * `MIKAN_LINK_URL`, the same env var the bot uses to build credential onboarding links.
 */
export function resolveLinkBaseUrl(): string | undefined {
  const raw = readEnv("LINK_URL");
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

function hasDefinedValue(values: Record<string, unknown> | undefined): boolean {
  return values !== undefined && Object.values(values).some((value) => value !== undefined);
}

function compactSettingsConfig(config: SettingsFileConfig): SettingsFileConfig {
  return {
    ...(hasDefinedValue(config.llm) ? { llm: config.llm } : {}),
    ...(hasDefinedValue(config.sentry) ? { sentry: config.sentry } : {}),
    ...(hasDefinedValue(config.sandbox) ? { sandbox: config.sandbox } : {}),
    ...(hasDefinedValue(config.autoReply) ? { autoReply: config.autoReply } : {}),
    ...(hasDefinedValue(config.slack) ? { slack: config.slack } : {}),
    ...(hasDefinedValue(config.retry) ? { retry: config.retry } : {}),
    ...(hasDefinedValue(config.compaction) ? { compaction: config.compaction } : {}),
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
    sandbox: {
      ...existing.sandbox,
      ...(config.sandboxCpus !== undefined ? { cpus: config.sandboxCpus } : {}),
      ...(config.sandboxMemory !== undefined ? { memory: config.sandboxMemory } : {}),
      ...(config.sandboxBoostCpus !== undefined || config.sandboxBoostMemory !== undefined
        ? {
            boost: {
              ...existing.sandbox?.boost,
              ...(config.sandboxBoostCpus !== undefined ? { cpus: config.sandboxBoostCpus } : {}),
              ...(config.sandboxBoostMemory !== undefined
                ? { memory: config.sandboxBoostMemory }
                : {}),
            },
          }
        : {}),
      ...(config.sandboxImageWorkspaceMount !== undefined
        ? {
            image: {
              ...existing.sandbox?.image,
              workspaceMount: config.sandboxImageWorkspaceMount,
            },
          }
        : {}),
      ...(config.defaultSharedVault !== undefined
        ? { defaultSharedVault: config.defaultSharedVault }
        : {}),
    },
    slack: {
      ...existing.slack,
      ...config.slack,
    },
    retry: {
      ...existing.retry,
      ...config.retry,
    },
    compaction: {
      ...existing.compaction,
      ...config.compaction,
    },
  };
  return compactSettingsConfig(patched);
}

function updateSettingsFile(
  settingsPath: string,
  patch: Partial<AgentConfig>,
  defaultSettings: SettingsFileConfig,
): void {
  let existing = defaultSettings;
  if (existsSync(settingsPath)) {
    try {
      existing = loadSettingsFile(settingsPath) ?? {};
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = detail.startsWith("Malformed settings file")
        ? detail.replace("Malformed settings file", "Refusing to overwrite malformed settings file")
        : detail;
      throw new Error(message, { cause: err });
    }
  }

  ensureDirExists(dirname(settingsPath));
  atomicWritePrivateFile(
    settingsPath,
    JSON.stringify(patchSettingsConfig(existing, patch), null, 2),
  );
}

export function updateGlobalSettings(patch: Partial<AgentConfig>): void {
  updateSettingsFile(join(getStateDir(), "settings.json"), patch, ONBOARD_SETTINGS);
}

export function updateConversationSettings(
  conversationDir: string,
  patch: Partial<AgentConfig>,
): void {
  updateSettingsFile(join(conversationDir, "settings.json"), patch, {});
}
