import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import { existsSync, readFileSync, renameSync, rmSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { effectiveStateDir } from "./cli/arg-grammar.js";
import { readEnv } from "./utils/env.js";
import { ensureDirExists, readJsonSchemaFileIfExists } from "./utils/file-guards.js";
import { atomicWritePrivateFile } from "./utils/fs-atomic.js";
import * as log from "./log.js";

export class MissingGlobalSettingsError extends Error {
  constructor(public readonly settingsPath: string) {
    super(`Missing global settings file at ${settingsPath}`);
    this.name = "MissingGlobalSettingsError";
  }
}

export type { AgentConfig, AutoReplyConfig, JudgeModelConfig, SandboxSettings } from "./types.js";
import type { AgentConfig, AutoReplyConfig, JudgeModelConfig, SandboxSettings } from "./types.js";

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
          Type.Literal("max"),
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
});

type SettingsFileConfig = Static<typeof SettingsFileSchema>;

function loadSettingsFile(settingsPath: string): SettingsFileConfig | undefined {
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        sandbox?: { gondolin?: { remote?: unknown } };
      };
      if (raw?.sandbox?.gondolin?.remote !== undefined) {
        throw new Error(
          "sandbox.gondolin.remote is no longer supported; use gondolin:default and remove the remote setting",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("sandbox.gondolin.remote")) {
        throw error;
      }
    }
  }
  return readJsonSchemaFileIfExists(settingsPath, SettingsFileSchema, (detail) =>
    detail === "unexpected JSON shape"
      ? `Malformed settings file at ${settingsPath}: expected a JSON object at the top level`
      : `Malformed settings file at ${settingsPath}: ${detail}`,
  );
}

function getStateDir(): string {
  return effectiveStateDir();
}

function normalizeSettingsConfig(config: SettingsFileConfig): Partial<AgentConfig> {
  return {
    ...(config.llm?.provider !== undefined ? { provider: config.llm.provider } : {}),
    ...(config.llm?.model !== undefined ? { model: config.llm.model } : {}),
    ...(config.llm?.thinkingLevel !== undefined ? { thinkingLevel: config.llm.thinkingLevel } : {}),
    ...(config.sentry?.dsn !== undefined ? { sentryDsn: config.sentry.dsn } : {}),
    ...(config.sandbox !== undefined ? { sandbox: normalizeSandboxSettings(config.sandbox) } : {}),
    ...(config.slack !== undefined ? { slack: config.slack } : {}),
  };
}

/**
 * File shape → in-memory shape for the sandbox group. An empty or
 * whitespace-only `defaultSharedVault` means "no default" and is dropped;
 * non-empty values are trimmed. Everything else passes through as-is.
 */
function normalizeSandboxSettings(sandbox: SandboxSettings): SandboxSettings {
  const defaultSharedVault = sandbox.defaultSharedVault?.trim();
  return {
    ...(sandbox.cpus !== undefined ? { cpus: sandbox.cpus } : {}),
    ...(sandbox.memory !== undefined ? { memory: sandbox.memory } : {}),
    ...(sandbox.boost !== undefined ? { boost: sandbox.boost } : {}),
    ...(sandbox.image !== undefined ? { image: sandbox.image } : {}),
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
    ...(base.image || override.image ? { image: { ...base.image, ...override.image } } : {}),
  };
}

function getSettingsPath(): string {
  return join(getStateDir(), "settings.json");
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
  const sentryDsn = sentryDsnFrom(fromFile.sentryDsn);
  const sandbox = fromFile.sandbox;
  const slack = fromFile.slack;

  return {
    provider,
    model,
    thinkingLevel,
    sentryDsn,
    sandbox,
    slack,
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
 * `<stateDir>/conversations/<conversationId>/settings.json`.
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
export function conversationSettingsPath(conversationDir: string): string {
  const conversationId = basename(resolve(conversationDir));
  const hostPath = join(getStateDir(), "conversations", conversationId, "settings.json");
  if (existsSync(hostPath)) return hostPath;

  ensureDirExists(dirname(hostPath));
  const legacyPath = join(conversationDir, "settings.json");
  let content = "{}\n";
  let migrated = false;
  if (existsSync(legacyPath)) {
    try {
      content = readFileSync(legacyPath, "utf-8");
      migrated = true;
    } catch (err) {
      log.logWarning(`Could not read legacy conversation settings: ${legacyPath}`, String(err));
    }
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

export function resolveConversationSettings(conversationDir: string): AgentConfig {
  const globalConfig = loadRawGlobalSettings();
  const conversationConfig = normalizeSettingsConfig(
    loadSettingsFile(conversationSettingsPath(conversationDir)) ?? {},
  );
  // The sandbox group merges at the leaf level (see mergeSandboxSettings):
  // a conversation that only sets sandbox.memory keeps the global sandbox.cpus.
  const sandbox = mergeSandboxSettings(globalConfig.sandbox, conversationConfig.sandbox);
  return toAgentConfig({
    ...globalConfig,
    ...conversationConfig,
    ...(sandbox ? { sandbox } : {}),
  });
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
    ? (loadSettingsFile(conversationSettingsPath(conversationDir)) ?? {})
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

/**
 * True when `child` is `parent` or a path inside it. Purely lexical (no
 * symlink resolution) — used for configuration sanity checks, not as the
 * final security boundary.
 */
export function isPathInside(child: string, parent: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath + "/");
}

/**
 * The state dir (extensions code, extension data, vaults, auth.json) must
 * never live inside the working dir: conversation opt-in "full" mode mounts
 * the entire working dir read-write into sandbox containers, and a mounted
 * state dir would let sandboxed code plant extension modules that the host
 * process later imports — a sandbox escape. Fatal under sandboxed modes;
 * host mode has no mounts, so only warn about the bad hygiene.
 */
export function assertStateDirOutsideWorkspace(
  stateDir: string,
  workingDir: string,
  sandboxType: string,
): void {
  if (!isPathInside(stateDir, workingDir)) return;
  const message =
    `--state-dir (${stateDir}) must not be inside the working directory (${workingDir}): ` +
    `sandbox containers mount the working directory, and a mounted state dir ` +
    `would expose extensions, vaults, and credentials to sandboxed code.`;
  if (sandboxType === "host") {
    log.logWarning("Insecure state dir location", message);
    return;
  }
  throw new Error(message);
}

/** Settings-file DSN wins over SENTRY_DSN env — the rule lives only here. */
function sentryDsnFrom(fromFile: string | undefined): string | undefined {
  return fromFile || readEnv("SENTRY_DSN");
}

export function resolveSentryDsn(): string | undefined {
  const fromFile = normalizeSettingsConfig(loadSettingsFile(getSettingsPath()) ?? {});
  return sentryDsnFrom(fromFile.sentryDsn);
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
  updateSettingsFile(conversationSettingsPath(conversationDir), patch, {});
}
