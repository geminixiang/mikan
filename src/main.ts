#!/usr/bin/env node

import "./observability/instrument.js";

import { join } from "node:path";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as pathJoin } from "node:path";
import type {
  MessagingBot,
  PlatformBlockKit,
  PlatformDmOpener,
  PlatformHistoryFetcher,
  PlatformName,
  PlatformNotifier,
  PlatformReactor,
  PlatformUploader,
  PlatformUserLister,
} from "./adapter.js";
import { DiscordMessagingBot } from "./adapters/discord/bot.js";
import { GithubMessagingBot } from "./adapters/github/bot.js";
import { createGithubToolPack } from "./adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "./adapters/github/types.js";
import { TelegramMessagingBot } from "./adapters/telegram/bot.js";
import { SlackMessagingBot as SlackMessagingBotClass } from "./adapters/slack/bot.js";
import { createSlackToolPack } from "./adapters/slack/tool-pack.js";
import type { PlatformSlackOps } from "./adapters/slack/types.js";
import type { PlatformToolPackFactory } from "./tools/types.js";
import { downloadChannel } from "./cli/download.js";
import { EventsWatcher } from "./events.js";
import { ExtensionCallbackScheduler } from "./extension-schedules.js";
import * as log from "./log.js";
import { startWebServer } from "./web/server.js";
import { InMemoryAdminTokenStore } from "./web/admin/portal.js";
import { InMemoryLinkTokenStore } from "./web/login/portal.js";
import { InMemorySessionViewTokenStore } from "./web/session-view/portal.js";
import { DockerContainerManager } from "./provisioner.js";
import {
  assertStateDirOutsideWorkspace,
  loadGlobalSettings,
  MissingGlobalSettingsError,
  resolveLinkBaseUrl,
} from "./config.js";
import {
  configureHttpDispatcher,
  defaultModelsJsonPath,
  parseHttpIdleTimeoutMs,
} from "./harness/index.js";
import { existsSync, readFileSync } from "node:fs";
import { readEnv, setEnvAliases } from "./env-manifest.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./utils/file-guards.js";
import { SandboxError, validateSandbox } from "./sandbox/index.js";
import { helpText, resolveBoot, type BootPlan } from "./cli/boot.js";
import { runOnboardCommand } from "./cli/onboard.js";
import { envReport, noPlatformsMessage, platformIsActive } from "./env-manifest.js";
import {
  configureGondolinRuntime,
  gondolinResources,
  reconcileGondolinRuntimes,
  stopAllGondolinRuntimes,
  stopIdleGondolinVms,
} from "./sandbox/gondolin.js";
import { FileVaultManager } from "./vault/index.js";
import { runExtCommand } from "./cli/ext.js";
import { runOfficeCommand } from "./cli/office.js";
import { runSessionsCommand } from "./cli/sessions.js";
import {
  buildContainerBindTranslator,
  createWorkspace,
  formatUnmigratedOfficesError,
  migrateLegacyOffices,
  OfficeRegistry,
} from "./office/index.js";
import { createConversationRuntime } from "./runtime/conversation-runtime.js";
import * as Sentry from "@sentry/node";

function getVersion(): string {
  // Try to find package.json in the dist directory or parent
  const possiblePaths = [
    pathJoin(dirname(fileURLToPath(import.meta.url)), "package.json"),
    pathJoin(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    pathJoin(process.cwd(), "package.json"),
  ];

  for (const pkgPath of possiblePaths) {
    const pkg = readJsonFileIfExists(
      pkgPath,
      (value): value is { version?: unknown } => isRecord(value),
      () => "Ignoring package.json while resolving version",
    );
    if (typeof pkg?.version === "string" && pkg.version) return pkg.version;
  }
  return "unknown";
}

const SLACK_APP_TOKEN = readEnv("SLACK_APP_TOKEN");
const SLACK_BOT_TOKEN = readEnv("SLACK_BOT_TOKEN");
const TELEGRAM_BOT_TOKEN = readEnv("TELEGRAM_BOT_TOKEN");
const DISCORD_BOT_TOKEN = readEnv("DISCORD_BOT_TOKEN");
const GITHUB_APP_ID = readEnv("GITHUB_APP_ID");
const GITHUB_APP_PRIVATE_KEY = readEnv("GITHUB_APP_PRIVATE_KEY");
const GITHUB_APP_PRIVATE_KEY_PATH = readEnv("GITHUB_APP_PRIVATE_KEY_PATH");
const GITHUB_INSTALLATION_ID = readEnv("GITHUB_INSTALLATION_ID");
const GITHUB_REPOS = readEnv("GITHUB_REPOS");
const GITHUB_POLL_INTERVAL = readEnv("GITHUB_POLL_INTERVAL");
const GITHUB_WEBHOOK_SECRET = readEnv("GITHUB_WEBHOOK_SECRET");
// Externally-visible base URL of the link/OAuth server; the env read and
// trailing-slash normalization live in config.resolveLinkBaseUrl.
const LINK_BASE_URL = resolveLinkBaseUrl();
const LINK_PORT_RAW = readEnv("LINK_PORT");
const LINK_PORT = LINK_PORT_RAW ? parseInt(LINK_PORT_RAW, 10) : LINK_BASE_URL ? 8181 : undefined;

const WORLD_WRITABLE_MODE = 0o002;

function ensureSecureStateDir(path: string): void {
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return;
    }
    console.error(`Error: cannot access --state-dir ${path}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!stat.isDirectory()) {
    console.error(`Error: --state-dir ${path} exists but is not a directory`);
    process.exit(1);
  }

  if (stat.mode & WORLD_WRITABLE_MODE) {
    console.error(
      `Error: --state-dir ${path} is world-writable (mode ${(stat.mode & 0o777).toString(8)}). ` +
        `Credentials stored there would be exposed to other local users. ` +
        `Fix with: chmod 0700 ${path}`,
    );
    process.exit(1);
  }

  const euid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (euid !== undefined && stat.uid !== euid) {
    console.error(
      `Error: --state-dir ${path} is owned by uid ${stat.uid} but mikan is running as uid ${euid}. ` +
        `Run mikan as the directory owner or point --state-dir at a directory you own.`,
    );
    process.exit(1);
  }
}

function handleStartupError(error: unknown): never {
  if (error instanceof SandboxError) {
    for (const line of error.formatForCli()) {
      console.error(line);
    }
    process.exit(1);
  }
  if (error instanceof MissingGlobalSettingsError) {
    console.error(`Missing global settings: ${error.settingsPath}`);
    console.error("");
    console.error("Run onboarding to create it:");
    console.error(`  mikan --onboard --state-dir ${stateDir}`);
    console.error("");
    console.error("Then review the generated settings.json and start mikan again.");
    process.exit(1);
  }
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  console.error(String(error));
  process.exit(1);
}

let plan: BootPlan;
try {
  plan = resolveBoot();
} catch (error) {
  handleStartupError(error);
}

// `mikan ext …` manages extensions and exits; handle it before the normal
// bot-mode startup (which requires platform tokens).
if (plan.mode === "ext") {
  const code = await runExtCommand(plan.extArgs ?? []);
  process.exit(code);
}

// `mikan office …` inspects/claims conversation offices and exits.
if (plan.mode === "office") {
  process.exit(runOfficeCommand(plan.officeArgs ?? []));
}

// `mikan sessions …` migrates/maintains session files and exits.
if (plan.mode === "sessions") {
  process.exit(await runSessionsCommand(plan.sessionsArgs ?? []));
}

// Global fetch: proxy support (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) and idle
// timeouts so a stalled LLM stream errors out instead of hanging a session.
const httpIdleTimeoutMs = parseHttpIdleTimeoutMs(readEnv("HTTP_IDLE_TIMEOUT"));
configureHttpDispatcher(httpIdleTimeoutMs);

if (plan.mode === "help") {
  console.log(helpText());
  process.exit(0);
}

if (plan.mode === "env") {
  console.log(envReport());
  process.exit(0);
}

if (plan.mode === "version") {
  console.log(getVersion());
  process.exit(0);
}

// Handle onboard mode
if (plan.mode === "onboard") {
  const stateDir = plan.stateDir;
  setEnvAliases("STATE_DIR", stateDir);
  ensureSecureStateDir(stateDir);
  try {
    process.exit(await runOnboardCommand(stateDir));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Handle --download mode (Slack only)
if (plan.mode === "download" && plan.downloadChannel) {
  if (!SLACK_BOT_TOKEN) {
    console.error("Missing env: SLACK_BOT_TOKEN");
    process.exit(1);
  }
  await downloadChannel(plan.downloadChannel, SLACK_BOT_TOKEN);
  process.exit(0);
}

// Normal bot mode - working dir is optional and defaults under the state dir
const sandbox = plan.sandbox;
const stateDir = plan.stateDir;
const workingDir = plan.workingDir;
setEnvAliases("STATE_DIR", stateDir);
ensureSecureStateDir(stateDir);
if (!plan.workingDirExplicit) {
  ensureDirExists(workingDir);
}
try {
  assertStateDirOutsideWorkspace(stateDir, workingDir, sandbox.type);
} catch (error) {
  handleStartupError(error);
}

// Validate platform tokens — activation rules live in the env manifest.
const hasSlack = platformIsActive("slack");
const hasTelegram = platformIsActive("telegram");
const hasDiscord = platformIsActive("discord");
const hasGithub = platformIsActive("github");

if (!hasSlack && !hasTelegram && !hasDiscord && !hasGithub) {
  console.error(noPlatformsMessage());
  process.exit(1);
}

// Move legacy raw-id conversation directories to the office-key layout before
// anything touches the workspace. Runs every boot; a completed migration is a
// no-op. Unowned or failed offices are fatal: after the layout flip a legacy
// directory is invisible to the runtime, and booting anyway would present
// those conversations as silently empty.
const enabledPlatforms: PlatformName[] = [
  ...(hasSlack ? (["slack"] as const) : []),
  ...(hasTelegram ? (["telegram"] as const) : []),
  ...(hasDiscord ? (["discord"] as const) : []),
  ...(hasGithub ? (["github"] as const) : []),
];
const officeMigration = (() => {
  try {
    return migrateLegacyOffices({ workspaceRoot: workingDir, stateDir, enabledPlatforms });
  } catch (error) {
    handleStartupError(error);
  }
})();
if (
  officeMigration.unowned.length > 0 ||
  officeMigration.failed.length > 0 ||
  officeMigration.vaultConflicts.length > 0 ||
  officeMigration.stateDirConflicts.length > 0
) {
  console.error(formatUnmigratedOfficesError(officeMigration));
  process.exit(1);
}
if (officeMigration.migrated.length > 0 || officeMigration.recovered.length > 0) {
  console.log(
    `  Office layout migration: ${officeMigration.migrated.length} moved, ` +
      `${officeMigration.recovered.length} recovered.`,
  );
}
if (officeMigration.vaultKeysMigrated.length > 0) {
  console.log(`  Vault keys migrated to office keys: ${officeMigration.vaultKeysMigrated.length}.`);
}
if (officeMigration.stateDirsMigrated.length > 0) {
  console.log(
    `  Host state dirs migrated to office keys: ${officeMigration.stateDirsMigrated.length}.`,
  );
}

try {
  await validateSandbox(sandbox);
} catch (error) {
  handleStartupError(error);
}

// The one Workspace value for this process: workspace-global paths plus the
// per-conversation Office factory. Constructed after the office migration so
// every office it materializes lands in the office-key layout.
const workspace = createWorkspace({ root: workingDir, stateDir });

const vaultManager = new FileVaultManager(stateDir);
if (vaultManager.isEnabled()) {
  console.log(
    sandbox.type === "container"
      ? "  Vault system enabled. Container vault active."
      : sandbox.type === "image" ||
          sandbox.type === "gondolin" ||
          sandbox.type === "firecracker" ||
          sandbox.type === "cloudflare"
        ? "  Vault system enabled. Conversation-scoped credential routing active."
        : "  Vault system enabled. Host mode will not inject vault env.",
  );
}

const startupConfig = (() => {
  try {
    return loadGlobalSettings();
  } catch (error) {
    handleStartupError(error);
  }
})();
const sandboxSettings = startupConfig.sandbox;
const sandboxLimits =
  sandboxSettings?.cpus || sandboxSettings?.memory
    ? { cpus: sandboxSettings?.cpus, memory: sandboxSettings?.memory }
    : undefined;
const sandboxBoostLimits =
  sandboxSettings?.boost?.cpus || sandboxSettings?.boost?.memory
    ? { cpus: sandboxSettings?.boost?.cpus, memory: sandboxSettings?.boost?.memory }
    : undefined;

const provisioner =
  sandbox.type === "image"
    ? new DockerContainerManager(sandbox.image, {
        limits: sandboxLimits,
        boostLimits: sandboxBoostLimits,
      })
    : undefined;
// Containers provisioned before the office migration mount the renamed
// legacy paths. Their writable layers (everything installed inside) are
// preserved: each container is committed and recreated with translated
// mounts — on demand before its next message, and via a background sweep
// after the bots start.
const registryOffices = new OfficeRegistry(stateDir).getOffices();
if (provisioner && registryOffices.length > 0) {
  provisioner.armContainerLayoutMigration(
    buildContainerBindTranslator({
      offices: registryOffices,
      workspaceRoot: workingDir,
      stateDir,
    }),
  );
}
if (sandbox.type === "gondolin") {
  try {
    configureGondolinRuntime({
      limits: sandboxLimits,
      boostLimits: sandboxBoostLimits,
    });
  } catch (error) {
    handleStartupError(error);
  }
}
const resourceController =
  sandbox.type === "image"
    ? provisioner
    : sandbox.type === "gondolin"
      ? gondolinResources
      : undefined;

if (sandbox.type === "image" || sandbox.type === "gondolin") {
  ensureDirExists(workspace.skillsDir);
  ensureDirExists(workspace.eventsDir);
  ensureDirExists(workspace.agentsDir);
  try {
    writeFileSync(workspace.memoryPath, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

const linkTokenStore = new InMemoryLinkTokenStore();
const sessionViewTokenStore = new InMemorySessionViewTokenStore();
const adminTokenStore = new InMemoryAdminTokenStore();
setInterval(() => linkTokenStore.purge(), 5 * 60 * 1000).unref();
setInterval(() => sessionViewTokenStore.purge(), 5 * 60 * 1000).unref();
setInterval(() => adminTokenStore.purge(), 5 * 60 * 1000).unref();

function portalBaseUrl(): string | undefined {
  if (LINK_BASE_URL) return LINK_BASE_URL;
  if (LINK_PORT) return `http://localhost:${LINK_PORT}`;
  return undefined;
}
/** Idle timeout for managed sandboxes (10 minutes) */
const MANAGED_SANDBOX_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

if (provisioner) {
  await provisioner.reconcile();
  await provisioner.stopIdle(MANAGED_SANDBOX_IDLE_TIMEOUT_MS);
  setInterval(
    () => provisioner.stopIdle(MANAGED_SANDBOX_IDLE_TIMEOUT_MS),
    MANAGED_SANDBOX_IDLE_TIMEOUT_MS,
  ).unref();
}

if (sandbox.type === "gondolin") {
  await reconcileGondolinRuntimes();
  setInterval(
    () => void stopIdleGondolinVms(MANAGED_SANDBOX_IDLE_TIMEOUT_MS),
    MANAGED_SANDBOX_IDLE_TIMEOUT_MS,
  ).unref();
}
const botsByPlatform: Record<string, MessagingBot> = {};

/**
 * Resolve which platform bot to use: an explicit platform, or the sole
 * running one. Mirrors event-file platform resolution.
 */
function resolvePlatformBot(op: string, platform: string | undefined): [string, MessagingBot] {
  const available = Object.keys(botsByPlatform);
  const key = platform?.trim().toLowerCase() || (available.length === 1 ? available[0] : undefined);
  const bot = key ? botsByPlatform[key] : undefined;
  if (!bot) {
    throw new Error(
      platform
        ? `${op}: unknown platform '${platform}' (available: ${available.join(", ") || "none"})`
        : `${op}: multiple platforms active (${available.join(", ")}); specify platform`,
    );
  }
  return [key!, bot];
}

/** Extension `api.notify` backend: post into a conversation without a run. */
const platformNotifier: PlatformNotifier = async (conversationId, text, options) => {
  const [key, bot] = resolvePlatformBot("notify", options?.platform);
  let messageTs: string;
  if (options?.threadTs) {
    if (!bot.postInThread) {
      throw new Error(`notify: platform '${key}' does not support threaded posts`);
    }
    messageTs = await bot.postInThread(conversationId, options.threadTs, text);
  } else {
    messageTs = await bot.postMessage(conversationId, text);
  }
  log.logInfo(`[notify] posted to ${key}/${conversationId} (${text.length} chars)`);
  return messageTs;
};

/** Extension `api.openDm` backend: resolve a user's DM conversation id. */
const platformDmOpener: PlatformDmOpener = async (userId, platform) => {
  const [key, bot] = resolvePlatformBot("openDm", platform);
  if (!bot.openDirectConversation) {
    throw new Error(`openDm: platform '${key}' does not support opening direct messages`);
  }
  return bot.openDirectConversation(userId);
};

/** Extension `api.fetchHistory` backend: read recent conversation messages. */
const platformHistoryFetcher: PlatformHistoryFetcher = async (conversationId, options) => {
  const [key, bot] = resolvePlatformBot("fetchHistory", options?.platform);
  if (!bot.fetchHistory) {
    throw new Error(`fetchHistory: platform '${key}' does not support history reads`);
  }
  const { platform: _platform, ...historyOptions } = options ?? {};
  return bot.fetchHistory(conversationId, historyOptions);
};

/** Extension `api.listUsers` backend: list the workspace's active users. */
const platformUserLister: PlatformUserLister = async (platform) => {
  const [key, bot] = resolvePlatformBot("listUsers", platform);
  if (!bot.listUsers) {
    throw new Error(`listUsers: platform '${key}' does not support user listings`);
  }
  return bot.listUsers();
};

/** Extension `api.react` backend: add a reaction to a message. */
const platformReactor: PlatformReactor = async (conversationId, messageTs, emoji, platform) => {
  const [key, bot] = resolvePlatformBot("react", platform);
  if (!bot.addReaction) {
    throw new Error(`react: platform '${key}' does not support reactions`);
  }
  await bot.addReaction(conversationId, messageTs, emoji);
  log.logInfo(`[react] :${emoji}: on ${key}/${conversationId}`);
};

/** Extension `api.uploadFile` backend: send a host file into a conversation. */
const platformUploader: PlatformUploader = async (conversationId, filePath, title, platform) => {
  const [key, bot] = resolvePlatformBot("upload", platform);
  if (!bot.uploadFile) {
    throw new Error(`upload: platform '${key}' does not support file uploads`);
  }
  await bot.uploadFile(conversationId, filePath, title);
  log.logInfo(`[upload] ${filePath} to ${key}/${conversationId}`);
};

/** github_* tool backends: PR push/create and CI checks, host-side. */
function requireGithubBot(op: string): GithubMessagingBot {
  const bot = botsByPlatform.github as GithubMessagingBot | undefined;
  if (!bot) {
    throw new Error(`${op}: the GitHub platform is not running`);
  }
  return bot;
}

/** slack_* tool backends: Block Kit posting/updating, host-side. */
function requireSlackBot(op: string): SlackMessagingBotClass {
  const bot = botsByPlatform.slack as SlackMessagingBotClass | undefined;
  if (!bot) {
    throw new Error(`${op}: the Slack platform is not running`);
  }
  return bot;
}

/** Extension `api.blockkit` backend: interactive Block Kit, Slack-only today. */
const platformBlockKit: PlatformBlockKit = {
  postBlocks: async (conversationId, message, platform) => {
    if (platform && platform !== "slack") {
      throw new Error(`blockkit: platform '${platform}' does not support Block Kit`);
    }
    const bot = requireSlackBot("blockkit");
    const ts = message.threadTs
      ? await bot.postInThreadBlocks(conversationId, message.threadTs, message.text, message.blocks)
      : await bot.postMessageBlocks(conversationId, message.text, message.blocks);
    return { ts };
  },
  updateBlocks: async (conversationId, messageTs, message, platform) => {
    if (platform && platform !== "slack") {
      throw new Error(`blockkit: platform '${platform}' does not support Block Kit`);
    }
    await requireSlackBot("blockkit").updateMessageBlocks(
      conversationId,
      messageTs,
      message.text,
      message.blocks,
    );
  },
};

/**
 * Platform capability pack factories — only when the corresponding bot is
 * configured. Factories, not instances: each runner materializes its own
 * pack so per-run bind state never crosses conversations.
 */
function buildPlatformToolPackFactories(): PlatformToolPackFactory[] {
  const factories: PlatformToolPackFactory[] = [];
  if (hasSlack) {
    const platformSlackOps: PlatformSlackOps = {
      postBlocks: async (conversationId, { text, blocks, threadTs }) => {
        const bot = requireSlackBot("slack_blockkit");
        const ts = threadTs
          ? await bot.postInThreadBlocks(conversationId, threadTs, text, blocks)
          : await bot.postMessageBlocks(conversationId, text, blocks);
        bot.logBotResponse(conversationId, text, ts, threadTs, blocks);
        return { ts };
      },
      updateBlocks: async (conversationId, { ts, text, blocks, threadTs }) => {
        const bot = requireSlackBot("slack_blockkit");
        await bot.updateMessageBlocks(conversationId, ts, text, blocks);
        bot.logBotResponse(conversationId, text, ts, threadTs, blocks);
      },
      ownsBlockKitMessage: (conversationId, ts, threadTs) =>
        requireSlackBot("slack_blockkit").ownsBlockKitMessage(conversationId, ts, threadTs),
    };
    factories.push(() => createSlackToolPack(platformSlackOps));
  }
  if (!hasGithub) return factories;
  const platformGithubOps: PlatformGithubOps = {
    pushAndCreatePr: (conversationId, request) =>
      requireGithubBot("github_pr").ops.pushAndCreatePr(conversationId, request),
    getChecks: (conversationId, branch) =>
      requireGithubBot("github_checks").ops.getChecks(conversationId, branch),
    getJobLog: (conversationId, jobId) =>
      requireGithubBot("github_checks").ops.getJobLog(conversationId, jobId),
    replyToReviewThread: (conversationId, commentId, body) =>
      requireGithubBot("github_review_reply").ops.replyToReviewThread(
        conversationId,
        commentId,
        body,
      ),
    syncRepo: (conversationId, branch) =>
      requireGithubBot("github_sync").ops.syncRepo(conversationId, branch),
    readGithub: (conversationId, request) =>
      requireGithubBot("github_read").ops.readGithub(conversationId, request),
    manageIssue: (conversationId, request) =>
      requireGithubBot("github_issue").ops.manageIssue(conversationId, request),
  };
  factories.push(() => createGithubToolPack(platformGithubOps));
  return factories;
}

// Host-authoritative engine for extension callback schedules. Dispatch routes
// through the runtime so fires run against the conversation's activated
// extensions; created before the runtime, wired after (mutual reference).
const extensionScheduleEngine = new ExtensionCallbackScheduler({
  stateDir,
  dispatch: (fire) => handler.handleExtensionScheduleCallback(fire),
});

const handler = createConversationRuntime({
  workspace,
  sandbox,
  vaultManager,
  provisioner,
  resourceController,
  linkTokenStore,
  sessionViewTokenStore,
  adminTokenStore,
  portalBaseUrl: portalBaseUrl(),
  platformNotifier,
  platformReactor,
  platformUploader,
  platformBlockKit,
  platformDmOpener,
  platformHistoryFetcher,
  platformUserLister,
  extensionScheduleEngine,
  platformToolPackFactories: buildPlatformToolPackFactories(),
});

const sandboxDesc =
  sandbox.type === "host"
    ? "host"
    : sandbox.type === "container"
      ? `container:${sandbox.container}`
      : sandbox.type === "image"
        ? `image:${sandbox.image}`
        : sandbox.type === "gondolin"
          ? `gondolin:${sandbox.profile}`
          : sandbox.type === "firecracker"
            ? `firecracker:${sandbox.vmId}`
            : `cloudflare:${sandbox.sandboxId}`;
log.logStartup(workingDir, sandboxDesc);
logHarnessStartupSummary();

/**
 * One-look confirmation of the harness runtime surface, aimed at upgrade
 * verification: config moved from ~/.pi to ~/.mikan with no fallback, so a
 * missing auth.json here is the first thing to check when runs fail.
 */
function logHarnessStartupSummary(): void {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  log.logInfo(
    `HTTP dispatcher: idle timeout ${httpIdleTimeoutMs}ms${proxy ? `, proxy ${proxy}` : ", no proxy"}`,
  );

  const modelsPath = defaultModelsJsonPath();
  log.logInfo(
    existsSync(modelsPath)
      ? `Harness models.json: ${modelsPath}`
      : `Harness models.json: none (${modelsPath}) — built-in providers only`,
  );
}

if (hasSlack) {
  const slackMessagingBotToken = SLACK_BOT_TOKEN;
  const slackAppToken = SLACK_APP_TOKEN;
  if (!slackMessagingBotToken || !slackAppToken) {
    throw new Error("Slack startup requires both SLACK_APP_TOKEN and SLACK_BOT_TOKEN");
  }
  const slackMessagingBot = new SlackMessagingBotClass(handler, {
    appToken: slackAppToken,
    botToken: slackMessagingBotToken,
    workspace,
  });
  botsByPlatform.slack = slackMessagingBot;
  log.logInfo("Platform: Slack");
}
if (hasTelegram) {
  const telegramToken = TELEGRAM_BOT_TOKEN;
  if (!telegramToken) {
    throw new Error("Telegram startup requires TELEGRAM_BOT_TOKEN");
  }
  const telegramMessagingBot = new TelegramMessagingBot(handler, {
    token: telegramToken,
    workspace,
  });
  botsByPlatform.telegram = telegramMessagingBot;
  log.logInfo("Platform: Telegram");
}
if (hasDiscord) {
  const discordToken = DISCORD_BOT_TOKEN;
  if (!discordToken) {
    throw new Error("Discord startup requires DISCORD_BOT_TOKEN");
  }
  const discordMessagingBot = new DiscordMessagingBot(handler, {
    token: discordToken,
    workspace,
  });
  botsByPlatform.discord = discordMessagingBot;
  log.logInfo("Platform: Discord");
}
if (hasGithub) {
  if (!GITHUB_APP_ID || !GITHUB_INSTALLATION_ID) {
    throw new Error("GitHub startup requires GITHUB_APP_ID and GITHUB_INSTALLATION_ID");
  }
  // Env vars flatten PEM newlines to literal `\n`; a key file avoids that.
  const githubPrivateKey = GITHUB_APP_PRIVATE_KEY_PATH
    ? readFileSync(GITHUB_APP_PRIVATE_KEY_PATH, "utf-8")
    : GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!githubPrivateKey) {
    throw new Error(
      "GitHub startup requires GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH",
    );
  }
  const pollIntervalSeconds = GITHUB_POLL_INTERVAL ? parseInt(GITHUB_POLL_INTERVAL, 10) : NaN;
  const githubMessagingBot = new GithubMessagingBot(handler, {
    appId: GITHUB_APP_ID,
    privateKey: githubPrivateKey,
    installationId: GITHUB_INSTALLATION_ID,
    repos: GITHUB_REPOS
      ? GITHUB_REPOS.split(",")
          .map((repo) => repo.trim())
          .filter(Boolean)
      : [],
    pollIntervalMs:
      (Number.isFinite(pollIntervalSeconds) && pollIntervalSeconds > 0 ? pollIntervalSeconds : 60) *
      1000,
    workspace,
    syncStatePath: join(stateDir, "github-sync.json"),
  });
  botsByPlatform.github = githubMessagingBot;
  log.logInfo("Platform: GitHub");
}

const githubBotForWebhook = botsByPlatform.github as GithubMessagingBot | undefined;
if (GITHUB_WEBHOOK_SECRET && (!githubBotForWebhook || !LINK_PORT)) {
  log.logWarning(
    "GITHUB_WEBHOOK_SECRET is set but " +
      (githubBotForWebhook ? "LINK_PORT is not" : "the GitHub platform is not enabled") +
      " — the webhook endpoint will not be served",
  );
}

if (LINK_PORT) {
  startWebServer({
    port: LINK_PORT,
    linkTokenStore,
    vaultManager,
    notify: async (platform, conversationId, message) => {
      const bot = botsByPlatform[platform];
      if (bot) await bot.postMessage(conversationId, message);
    },
    sessionViewTokenStore,
    sessionViewInteractive: { handler, botsByPlatform },
    adminOptions: { adminTokenStore, workspace, runtime: handler, sandbox, botsByPlatform },
    githubWebhook:
      GITHUB_WEBHOOK_SECRET && githubBotForWebhook
        ? {
            secret: GITHUB_WEBHOOK_SECRET,
            onPoke: () => githubBotForWebhook.requestPoll(),
          }
        : undefined,
  });
}

// Start events watcher with explicit platform routing
const eventsWatcher = new EventsWatcher(workspace.eventsDir, botsByPlatform);
const slackMessagingBot = botsByPlatform.slack as SlackMessagingBotClass | undefined;
if (slackMessagingBot) {
  slackMessagingBot.setEventsWatcher(eventsWatcher);
}
eventsWatcher.start();
extensionScheduleEngine.start();

// Handle shutdown
async function shutdown(): Promise<void> {
  await handler.shutdown();
  eventsWatcher.stop();
  extensionScheduleEngine.stop();
  await stopAllGondolinRuntimes();
  await Sentry.close(5000);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start all bots
await Promise.all(
  Object.values(botsByPlatform).map((bot) =>
    bot.start().catch((err) => {
      log.logWarning("Failed to start bot", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }),
  ),
);

// Drain the container layout migration off the hot path; every unit is
// idempotent, so an interrupted sweep simply resumes on the next boot.
if (provisioner) {
  void provisioner.sweepContainerLayoutMigration().catch((err) => {
    log.logWarning(
      "Container layout sweep failed",
      err instanceof Error ? err.message : String(err),
    );
  });
}
