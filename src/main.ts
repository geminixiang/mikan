#!/usr/bin/env node

import "./instrument.js";

import { join, resolve } from "path";
import { mkdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import type { Bot } from "./adapter.js";
import { DiscordBot } from "./adapters/discord/index.js";
import { TelegramBot } from "./adapters/telegram/index.js";
import { SlackBot as SlackBotClass } from "./adapters/slack/index.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { startLinkServer } from "./login/portal.js";
import { InMemoryLinkTokenStore } from "./login/session.js";
import { InMemorySessionViewTokenStore } from "./session-view/store.js";
import { DockerContainerManager } from "./provisioner.js";
import { createGlobalSettingsFile, loadAgentConfig, MissingGlobalSettingsError } from "./config.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./file-guards.js";
import {
  SandboxError,
  parseSandboxArg,
  type SandboxConfig,
  validateSandbox,
} from "./sandbox/index.js";
import { FileVaultManager } from "./vault.js";
import { createSessionRuntime } from "./runtime/index.js";
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

const MIKAN_SLACK_APP_TOKEN = process.env.MIKAN_SLACK_APP_TOKEN;
const MIKAN_SLACK_BOT_TOKEN = process.env.MIKAN_SLACK_BOT_TOKEN;
const MIKAN_TELEGRAM_BOT_TOKEN = process.env.MIKAN_TELEGRAM_BOT_TOKEN;
const MIKAN_DISCORD_BOT_TOKEN = process.env.MIKAN_DISCORD_BOT_TOKEN;
const MIKAN_LINK_URL = process.env.MIKAN_LINK_URL;
const MIKAN_LINK_PORT = process.env.MIKAN_LINK_PORT
  ? parseInt(process.env.MIKAN_LINK_PORT, 10)
  : MIKAN_LINK_URL
    ? 8181
    : undefined;

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

let parsedArgs: ParsedArgs;
try {
  parsedArgs = parseArgs();
} catch (error) {
  handleStartupError(error);
}

// Handle --version
if (parsedArgs.showVersion) {
  console.log(getVersion());
  process.exit(0);
}

// Handle --onboard mode
if (parsedArgs.showOnboard) {
  const stateDir = parsedArgs.stateDir ?? join(homedir(), ".mikan");
  process.env.MIKAN_STATE_DIR = stateDir;
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
  if (!MIKAN_SLACK_BOT_TOKEN) {
    console.error("Missing env: MIKAN_SLACK_BOT_TOKEN");
    process.exit(1);
  }
  await downloadChannel(parsedArgs.downloadChannel, MIKAN_SLACK_BOT_TOKEN);
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
process.env.MIKAN_STATE_DIR = stateDir;
ensureSecureStateDir(stateDir);

// Validate platform tokens
const hasSlack = !!(MIKAN_SLACK_APP_TOKEN && MIKAN_SLACK_BOT_TOKEN);
const hasTelegram = !!MIKAN_TELEGRAM_BOT_TOKEN;
const hasDiscord = !!MIKAN_DISCORD_BOT_TOKEN;

if (!hasSlack && !hasTelegram && !hasDiscord) {
  console.error(
    "No platform tokens found. Set one of:\n" +
      "  Slack:    MIKAN_SLACK_APP_TOKEN + MIKAN_SLACK_BOT_TOKEN\n" +
      "  Telegram: MIKAN_TELEGRAM_BOT_TOKEN\n" +
      "  Discord:  MIKAN_DISCORD_BOT_TOKEN",
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
    return loadAgentConfig();
  } catch (error) {
    handleStartupError(error);
  }
})();
const sandboxLimits =
  startupConfig.sandboxCpus || startupConfig.sandboxMemory
    ? { cpus: startupConfig.sandboxCpus, memory: startupConfig.sandboxMemory }
    : undefined;
const sandboxBoostLimits =
  startupConfig.sandboxBoostCpus || startupConfig.sandboxBoostMemory
    ? { cpus: startupConfig.sandboxBoostCpus, memory: startupConfig.sandboxBoostMemory }
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
setInterval(() => linkTokenStore.purge(), 5 * 60 * 1000).unref();
setInterval(() => sessionViewTokenStore.purge(), 5 * 60 * 1000).unref();

function portalBaseUrl(): string | undefined {
  if (MIKAN_LINK_URL) return MIKAN_LINK_URL.replace(/\/+$/, "");
  if (MIKAN_LINK_PORT) return `http://localhost:${MIKAN_LINK_PORT}`;
  return undefined;
}
/** Idle timeout for managed image containers (10 minutes) */
const IMAGE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

if (provisioner) {
  await provisioner.reconcile();
  await provisioner.stopIdle(IMAGE_IDLE_TIMEOUT_MS);
  setInterval(() => provisioner.stopIdle(IMAGE_IDLE_TIMEOUT_MS), IMAGE_IDLE_TIMEOUT_MS).unref();
}
const handler = createSessionRuntime({
  workingDir,
  sandbox,
  vaultManager,
  provisioner,
  linkTokenStore,
  sessionViewTokenStore,
  portalBaseUrl: portalBaseUrl(),
});

const sandboxDesc =
  sandbox.type === "host"
    ? "host"
    : sandbox.type === "container"
      ? `container:${sandbox.container}`
      : sandbox.type === "image"
        ? `image:${sandbox.image}`
        : sandbox.type === "firecracker"
          ? `firecracker:${sandbox.vmId}`
          : `cloudflare:${sandbox.sandboxId}`;
log.logStartup(workingDir, sandboxDesc);

const bots: Bot[] = [];
const botsByPlatform: Record<string, Bot> = {};

if (hasSlack) {
  const slackBotToken = MIKAN_SLACK_BOT_TOKEN;
  const slackAppToken = MIKAN_SLACK_APP_TOKEN;
  if (!slackBotToken || !slackAppToken) {
    throw new Error("Slack startup requires both MIKAN_SLACK_APP_TOKEN and MIKAN_SLACK_BOT_TOKEN");
  }
  const sharedStore = new ChannelStore({ workingDir, botToken: slackBotToken });
  const slackBot = new SlackBotClass(handler, {
    appToken: slackAppToken,
    botToken: slackBotToken,
    workingDir,
    store: sharedStore,
  });
  bots.push(slackBot);
  botsByPlatform.slack = slackBot;
  log.logInfo("Platform: Slack");
}
if (hasTelegram) {
  const telegramToken = MIKAN_TELEGRAM_BOT_TOKEN;
  if (!telegramToken) {
    throw new Error("Telegram startup requires MIKAN_TELEGRAM_BOT_TOKEN");
  }
  const telegramBot = new TelegramBot(handler, {
    token: telegramToken,
    workingDir,
  });
  bots.push(telegramBot);
  botsByPlatform.telegram = telegramBot;
  log.logInfo("Platform: Telegram");
}
if (hasDiscord) {
  const discordToken = MIKAN_DISCORD_BOT_TOKEN;
  if (!discordToken) {
    throw new Error("Discord startup requires MIKAN_DISCORD_BOT_TOKEN");
  }
  const discordBot = new DiscordBot(handler, {
    token: discordToken,
    workingDir,
  });
  bots.push(discordBot);
  botsByPlatform.discord = discordBot;
  log.logInfo("Platform: Discord");
}

if (MIKAN_LINK_PORT) {
  startLinkServer(
    MIKAN_LINK_PORT,
    linkTokenStore,
    vaultManager,
    async (platform, conversationId, message) => {
      const bot = botsByPlatform[platform];
      if (bot) await bot.postMessage(conversationId, message);
    },
    sessionViewTokenStore,
    { handler, botsByPlatform },
  );
}

// Start events watcher with explicit platform routing
const eventsWatcher = createEventsWatcher(workingDir, botsByPlatform);
const slackBot = botsByPlatform.slack as SlackBotClass | undefined;
if (slackBot) {
  slackBot.setEventsWatcher(eventsWatcher);
}
eventsWatcher.start();

// Handle shutdown
async function shutdown(): Promise<void> {
  await handler.shutdown();
  eventsWatcher.stop();
  await Sentry.close(5000);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start all bots
await Promise.all(
  bots.map((bot) =>
    bot.start().catch((err) => {
      log.logWarning("Failed to start bot", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }),
  ),
);
