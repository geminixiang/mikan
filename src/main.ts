#!/usr/bin/env node

import "./observability/instrument.js";

import { join, resolve } from "path";
import { mkdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import type {
  MessagingBot,
  PlatformNotifier,
  PlatformReactor,
  PlatformUploader,
} from "./adapter.js";
import { DiscordMessagingBot } from "./adapters/discord/bot.js";
import { GithubMessagingBot } from "./adapters/github/bot.js";
import { createGithubToolPack } from "./adapters/github/tool-pack.js";
import type { PlatformGithubOps } from "./adapters/github/types.js";
import { GcpTokenProvider } from "./adapters/github/gcp-auth.js";
import { TelegramMessagingBot } from "./adapters/telegram/bot.js";
import { SlackMessagingBot as SlackMessagingBotClass } from "./adapters/slack/bot.js";
import type { PlatformToolPackFactory } from "./tools/types.js";
import { downloadChannel } from "./cli/download.js";
import { EventsWatcher } from "./events.js";
import * as log from "./log.js";
import { startWebServer } from "./web/server.js";
import { InMemoryAdminTokenStore } from "./web/admin/store.js";
import { InMemoryLinkTokenStore } from "./web/login/store.js";
import { InMemorySessionViewTokenStore } from "./web/session-view/store.js";
import { DockerContainerManager } from "./provisioner.js";
import {
  assertStateDirOutsideWorkspace,
  createGlobalSettingsFile,
  loadGlobalSettings,
  MissingGlobalSettingsError,
} from "./config.js";
import {
  configureHttpDispatcher,
  defaultAuthPath,
  defaultModelsJsonPath,
  parseHttpIdleTimeoutMs,
} from "./harness/index.js";
import { existsSync, readFileSync } from "fs";
import { readEnv, setEnvAliases } from "./utils/env.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./utils/file-guards.js";
import {
  SandboxError,
  parseSandboxArg,
  type SandboxConfig,
  validateSandbox,
} from "./sandbox/index.js";
import { closeAllGondolinVms, stopIdleGondolinVms } from "./sandbox/gondolin.js";
import { FileVaultManager } from "./vault/index.js";
import { runExtCommand } from "./cli/ext.js";
import { createConversationRuntime } from "./runtime/conversation-runtime.js";
import { ChannelStore } from "./store.js";
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
const GOOGLE_APPLICATION_CREDENTIALS = readEnv("GOOGLE_APPLICATION_CREDENTIALS");
const GOOGLE_CLOUD_PROJECT = readEnv("GOOGLE_CLOUD_PROJECT");
const LINK_URL = readEnv("LINK_URL");
const LINK_PORT_RAW = readEnv("LINK_PORT");
const LINK_PORT = LINK_PORT_RAW ? parseInt(LINK_PORT_RAW, 10) : LINK_URL ? 8181 : undefined;

interface ParsedArgs {
  workingDir?: string;
  stateDir?: string;
  sandbox: SandboxConfig;
  downloadChannel?: string;
  showOnboard?: boolean;
  showVersion?: boolean;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let sandbox: SandboxConfig = { type: "host" };
  let workingDir: string | undefined;
  let stateDirArg: string | undefined;
  let downloadChannelId: string | undefined;
  let showOnboard = false;
  let showVersion = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v" || arg === "-V") {
      showVersion = true;
    } else if (arg === "--onboard") {
      showOnboard = true;
    } else if (arg.startsWith("--sandbox=")) {
      sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
    } else if (arg === "--sandbox") {
      sandbox = parseSandboxArg(args[++i] || "");
    } else if (arg.startsWith("--state-dir=")) {
      stateDirArg = arg.slice("--state-dir=".length);
    } else if (arg === "--state-dir") {
      stateDirArg = args[++i];
    } else if (arg.startsWith("--download=")) {
      downloadChannelId = arg.slice("--download=".length);
    } else if (arg === "--download") {
      downloadChannelId = args[++i];
    } else if (!arg.startsWith("-")) {
      workingDir = arg;
    }
  }

  return {
    workingDir: workingDir ? resolve(workingDir) : undefined,
    stateDir: stateDirArg ? resolve(stateDirArg) : undefined,
    sandbox,
    downloadChannel: downloadChannelId,
    showOnboard,
    showVersion,
  };
}

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

// `mikan ext …` manages extensions and exits; handle it before the normal
// bot-mode argument parsing (which requires a workspace dir and tokens).
if (process.argv[2] === "ext") {
  const code = await runExtCommand(process.argv.slice(3));
  process.exit(code);
}

let parsedArgs: ParsedArgs;
try {
  parsedArgs = parseArgs();
} catch (error) {
  handleStartupError(error);
}

// Global fetch: proxy support (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) and idle
// timeouts so a stalled LLM stream errors out instead of hanging a session.
const httpIdleTimeoutMs = parseHttpIdleTimeoutMs(readEnv("HTTP_IDLE_TIMEOUT"));
configureHttpDispatcher(httpIdleTimeoutMs);

// Handle --version
if (parsedArgs.showVersion) {
  console.log(getVersion());
  process.exit(0);
}

// Handle --onboard mode
if (parsedArgs.showOnboard) {
  const stateDir = parsedArgs.stateDir ?? join(homedir(), ".mikan");
  setEnvAliases("STATE_DIR", stateDir);
  ensureSecureStateDir(stateDir);
  try {
    const settingsPath = createGlobalSettingsFile(stateDir);
    console.log(`Created global settings at ${settingsPath}`);
    console.log("Review the file, then start mikan with your working directory.");
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Handle --download mode (Slack only)
if (parsedArgs.downloadChannel) {
  if (!SLACK_BOT_TOKEN) {
    console.error("Missing env: SLACK_BOT_TOKEN");
    process.exit(1);
  }
  await downloadChannel(parsedArgs.downloadChannel, SLACK_BOT_TOKEN);
  process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
  console.error(
    "Usage: mikan [--state-dir=<dir>] [--sandbox=host|container:<name>|image:<image>|firecracker:<vm-id>:<host-path>|cloudflare:<sandbox-id>] <working-directory>",
  );
  console.error("       mikan --onboard [--state-dir=<dir>]");
  console.error("       mikan --download <channel-id>");
  process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };
const stateDir = parsedArgs.stateDir ?? join(homedir(), ".mikan");
setEnvAliases("STATE_DIR", stateDir);
ensureSecureStateDir(stateDir);
try {
  assertStateDirOutsideWorkspace(stateDir, workingDir, sandbox.type);
} catch (error) {
  handleStartupError(error);
}

// Validate platform tokens
const hasSlack = !!(SLACK_APP_TOKEN && SLACK_BOT_TOKEN);
const hasTelegram = !!TELEGRAM_BOT_TOKEN;
const hasDiscord = !!DISCORD_BOT_TOKEN;
const hasGithub = !!(
  GITHUB_APP_ID &&
  GITHUB_INSTALLATION_ID &&
  (GITHUB_APP_PRIVATE_KEY || GITHUB_APP_PRIVATE_KEY_PATH)
);

if (!hasSlack && !hasTelegram && !hasDiscord && !hasGithub) {
  console.error(
    "No platform tokens found. Set one of:\n" +
      "  Slack:    SLACK_APP_TOKEN + SLACK_BOT_TOKEN\n" +
      "  Telegram: TELEGRAM_BOT_TOKEN\n" +
      "  Discord:  DISCORD_BOT_TOKEN\n" +
      "  GitHub:   GITHUB_APP_ID + GITHUB_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY(_PATH)",
  );
  process.exit(1);
}

try {
  await validateSandbox(sandbox);
} catch (error) {
  handleStartupError(error);
}

const vaultManager = new FileVaultManager(stateDir);
if (vaultManager.isEnabled()) {
  console.log(
    sandbox.type === "container"
      ? "  Vault system enabled. Container vault active."
      : sandbox.type === "image" || sandbox.type === "firecracker" || sandbox.type === "cloudflare"
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

if (sandbox.type === "image") {
  ensureDirExists(join(workingDir, "skills"));
  ensureDirExists(join(workingDir, "events"));
  try {
    writeFileSync(join(workingDir, "MEMORY.md"), "", { flag: "wx" });
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
  if (LINK_URL) return LINK_URL.replace(/\/+$/, "");
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
const platformNotifier: PlatformNotifier = async (conversationId, text, platform) => {
  const [key, bot] = resolvePlatformBot("notify", platform);
  await bot.postMessage(conversationId, text);
  log.logInfo(`[notify] posted to ${key}/${conversationId} (${text.length} chars)`);
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

/**
 * Platform capability pack factories — only when the corresponding bot is
 * configured. Factories, not instances: each runner materializes its own
 * pack so per-run bind state never crosses conversations.
 */
function buildPlatformToolPackFactories(): PlatformToolPackFactory[] {
  if (!hasGithub) return [];
  const platformGithubOps: PlatformGithubOps = {
    pushAndCreatePr: (conversationId, request) =>
      requireGithubBot("github_pr").pushAndCreatePr(conversationId, request),
    getChecks: (conversationId, branch) =>
      requireGithubBot("github_checks").getChecks(conversationId, branch),
    getJobLog: (conversationId, jobId) =>
      requireGithubBot("github_checks").getJobLog(conversationId, jobId),
    getBuildLog: (conversationId, buildId) =>
      requireGithubBot("github_checks").getBuildLog(conversationId, buildId),
    replyToReviewThread: (conversationId, commentId, body) =>
      requireGithubBot("github_review_reply").replyToReviewThread(conversationId, commentId, body),
    syncRepo: (conversationId, branch) =>
      requireGithubBot("github_sync").syncRepo(conversationId, branch),
    readGithub: (conversationId, request) =>
      requireGithubBot("github_read").readGithub(conversationId, request),
    manageIssue: (conversationId, request) =>
      requireGithubBot("github_issue").manageIssue(conversationId, request),
  };
  return [() => createGithubToolPack(platformGithubOps)];
}

const handler = createConversationRuntime({
  workingDir,
  sandbox,
  vaultManager,
  provisioner,
  linkTokenStore,
  sessionViewTokenStore,
  adminTokenStore,
  portalBaseUrl: portalBaseUrl(),
  platformNotifier,
  platformReactor,
  platformUploader,
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

  const authPath = defaultAuthPath();
  if (existsSync(authPath)) {
    try {
      const providers = Object.keys(JSON.parse(readFileSync(authPath, "utf-8")) as object);
      log.logInfo(`Harness auth: ${authPath} (providers: ${providers.join(", ") || "none"})`);
    } catch {
      log.logWarning(`Harness auth: ${authPath} exists but is not valid JSON`);
    }
  } else {
    log.logInfo(`Harness auth: ${authPath} missing — provider keys come from env vars only`);
  }

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
  const sharedStore = new ChannelStore({ workingDir, botToken: slackMessagingBotToken });
  const slackMessagingBot = new SlackMessagingBotClass(handler, {
    appToken: slackAppToken,
    botToken: slackMessagingBotToken,
    workingDir,
    store: sharedStore,
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
    workingDir,
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
    workingDir,
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
    workingDir,
    syncStatePath: join(stateDir, "github-sync.json"),
    // Host-side GCP creds (e.g. a WIF external_account file) unlock Cloud
    // Build logs in github_checks; without them external CI degrades to
    // guidance text. Credentials never enter the sandbox.
    cloudBuild: GOOGLE_APPLICATION_CREDENTIALS
      ? {
          tokenProvider: new GcpTokenProvider({
            credentialsPath: GOOGLE_APPLICATION_CREDENTIALS,
          }),
          projectFallback: GOOGLE_CLOUD_PROJECT,
        }
      : undefined,
  });
  botsByPlatform.github = githubMessagingBot;
  log.logInfo(
    `Platform: GitHub${GOOGLE_APPLICATION_CREDENTIALS ? " (Cloud Build logs enabled)" : ""}`,
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
    adminOptions: { adminTokenStore, workingDir, runtime: handler, sandbox, botsByPlatform },
  });
}

// Start events watcher with explicit platform routing
const eventsWatcher = new EventsWatcher(join(workingDir, "events"), botsByPlatform);
const slackMessagingBot = botsByPlatform.slack as SlackMessagingBotClass | undefined;
if (slackMessagingBot) {
  slackMessagingBot.setEventsWatcher(eventsWatcher);
}
eventsWatcher.start();

// Handle shutdown
async function shutdown(): Promise<void> {
  await handler.shutdown();
  eventsWatcher.stop();
  await closeAllGondolinVms();
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
