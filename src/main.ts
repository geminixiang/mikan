#!/usr/bin/env node

import "./observability/instrument.js";

import { join } from "path";
import { mkdirSync, statSync, writeFileSync } from "fs";
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
import { SandboxError, validateSandbox } from "./sandbox/index.js";
import { helpText, resolveBoot, type BootPlan } from "./cli/boot.js";
import {
  disconnectAllGondolinRuntimes,
  gondolinResources,
  stopIdleGondolinVms,
  sweepUnadoptedGondolinWorkers,
} from "./sandbox/gondolin.js";
import { configureGondolinRuntime } from "./sandbox/gondolin-bootstrap.js";
import { gondolinInventory } from "./sandbox/gondolin-inventory.js";
import { gondolinFleet } from "./sandbox/gondolin-fleet.js";
import { gondolinGateway } from "./sandbox/gondolin-gateway.js";
import { gondolinJoin } from "./sandbox/gondolin-join.js";
import { checkWorkspaceExported } from "./sandbox/gondolin-nfs-advisory.js";
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

// Global fetch: proxy support (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) and idle
// timeouts so a stalled LLM stream errors out instead of hanging a session.
const httpIdleTimeoutMs = parseHttpIdleTimeoutMs(readEnv("HTTP_IDLE_TIMEOUT"));
configureHttpDispatcher(httpIdleTimeoutMs);

if (plan.mode === "help") {
  console.log(helpText());
  process.exit(0);
}

if (plan.mode === "version") {
  console.log(getVersion());
  process.exit(0);
}

// Handle --worker-token: mint a one-time join token for a dial-home worker
if (plan.mode === "worker-token") {
  const stateDir = plan.stateDir;
  setEnvAliases("STATE_DIR", stateDir);
  ensureSecureStateDir(stateDir);
  gondolinJoin.configure(join(stateDir, "gondolin-gateway"));
  try {
    let gatewayPort = 8433;
    let gatewayHost: string | undefined;
    try {
      const gateway = loadGlobalSettings().sandbox?.gondolin?.remote?.gateway;
      if (gateway) {
        gatewayPort = gateway.port;
        gatewayHost = gateway.hostnames?.[0];
      }
    } catch {
      // settings are optional for minting; the CA lives in the state dir
    }
    const minted = await gondolinJoin.mintToken();
    const host = gatewayHost ?? "<mikan-host>";
    console.log("Worker join token (single use, expires in 15 minutes):");
    console.log("");
    console.log(`  mikan-worker join https://${host}:${gatewayPort} \\`);
    console.log(`    --token ${minted.token} \\`);
    console.log(`    --ca-pin ${minted.fingerprint} \\`);
    console.log(`    --name <worker-name> --workspace-root <shared-workspace-path> \\`);
    console.log(`    --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js`);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Handle --onboard mode
if (plan.mode === "onboard") {
  const stateDir = plan.stateDir;
  setEnvAliases("STATE_DIR", stateDir);
  ensureSecureStateDir(stateDir);
  try {
    const settingsPath = createGlobalSettingsFile(stateDir);
    console.log(`Created global settings at ${settingsPath}`);
    console.log(
      `Review the file, then start mikan (workspace defaults to ${join(stateDir, "workspace")}).`,
    );
    process.exit(0);
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
if (sandbox.type === "gondolin") {
  try {
    configureGondolinRuntime({
      stateDir,
      limits: sandboxLimits,
      boostLimits: sandboxBoostLimits,
      remote: sandboxSettings?.gondolin?.remote,
      requireRemote: sandbox.profile === "remote",
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

if (sandbox.type === "gondolin" && sandbox.profile === "remote") {
  checkWorkspaceExported(workingDir, sandboxSettings?.gondolin?.remote?.gateway?.hostnames?.[0]);
  await gondolinGateway.start();
  await gondolinFleet.reconcile();
  setInterval(() => {
    void stopIdleGondolinVms(MANAGED_SANDBOX_IDLE_TIMEOUT_MS);
    void gondolinFleet.reconcile();
  }, MANAGED_SANDBOX_IDLE_TIMEOUT_MS).unref();
} else if (sandbox.type === "gondolin") {
  gondolinInventory.touchHeartbeat();
  await gondolinInventory.reconcile();
  setInterval(() => {
    gondolinInventory.touchHeartbeat();
    void stopIdleGondolinVms(MANAGED_SANDBOX_IDLE_TIMEOUT_MS);
    void sweepUnadoptedGondolinWorkers();
  }, MANAGED_SANDBOX_IDLE_TIMEOUT_MS).unref();
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
      requireGithubBot("github_pr").ops.pushAndCreatePr(conversationId, request),
    getChecks: (conversationId, branch) =>
      requireGithubBot("github_checks").ops.getChecks(conversationId, branch),
    getJobLog: (conversationId, jobId) =>
      requireGithubBot("github_checks").ops.getJobLog(conversationId, jobId),
    getBuildLog: (conversationId, buildId) =>
      requireGithubBot("github_checks").ops.getBuildLog(conversationId, buildId),
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
  return [() => createGithubToolPack(platformGithubOps)];
}

const handler = createConversationRuntime({
  workingDir,
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
  await disconnectAllGondolinRuntimes();
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
