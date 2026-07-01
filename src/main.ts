#!/usr/bin/env node

import "./observability/instrument.js";

import { join, resolve } from "path";
import { mkdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join as pathJoin } from "path";
import type { MessagingBot } from "./adapter.js";
import { DiscordMessagingBot } from "./adapters/discord/bot.js";
import { TelegramMessagingBot } from "./adapters/telegram/bot.js";
import { SlackMessagingBot as SlackMessagingBotClass } from "./adapters/slack/bot.js";
import { downloadChannel } from "./download.js";
import { EventsWatcher } from "./events.js";
import * as log from "./log.js";
import { startWebServer } from "./web/server.js";
import { createGlobalSettingsFile, MissingGlobalSettingsError } from "./config.js";
import { readEnv, setEnvAliases } from "./utils/env.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "./utils/file-guards.js";
import { SandboxError, parseSandboxArg, type SandboxConfig } from "./sandbox/index.js";
import { MikanHarness } from "./mikan-harness.js";
import { ChannelStore } from "./store.js";
import { getExtensionsDir, getMikanDir } from "./harness/config.js";
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
  const stateDir = parsedArgs.stateDir ?? getMikanDir();
  setEnvAliases("STATE_DIR", stateDir);
  ensureSecureStateDir(stateDir);
  ensureDirExists(getExtensionsDir());
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
const stateDir = parsedArgs.stateDir ?? getMikanDir();
setEnvAliases("STATE_DIR", stateDir);
ensureSecureStateDir(stateDir);
ensureDirExists(getExtensionsDir());

// Validate platform tokens
const hasSlack = !!(SLACK_APP_TOKEN && SLACK_BOT_TOKEN);
const hasTelegram = !!TELEGRAM_BOT_TOKEN;
const hasDiscord = !!DISCORD_BOT_TOKEN;

if (!hasSlack && !hasTelegram && !hasDiscord) {
  console.error(
    "No platform tokens found. Set one of:\n" +
      "  Slack:    SLACK_APP_TOKEN + SLACK_BOT_TOKEN\n" +
      "  Telegram: TELEGRAM_BOT_TOKEN\n" +
      "  Discord:  DISCORD_BOT_TOKEN",
  );
  process.exit(1);
}

function portalBaseUrl(): string | undefined {
  if (LINK_URL) return LINK_URL.replace(/\/+$/, "");
  if (LINK_PORT) return `http://localhost:${LINK_PORT}`;
  return undefined;
}

let mikan: MikanHarness;
try {
  mikan = await MikanHarness.create({
    workingDir,
    stateDir,
    sandbox,
    portalBaseUrl: portalBaseUrl(),
  });
} catch (error) {
  handleStartupError(error);
}

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

const bots: MessagingBot[] = [];
const botsByPlatform: Record<string, MessagingBot> = {};

if (hasSlack) {
  const slackMessagingBotToken = SLACK_BOT_TOKEN;
  const slackAppToken = SLACK_APP_TOKEN;
  if (!slackMessagingBotToken || !slackAppToken) {
    throw new Error("Slack startup requires both SLACK_APP_TOKEN and SLACK_BOT_TOKEN");
  }
  const sharedStore = new ChannelStore({ workingDir, botToken: slackMessagingBotToken });
  const slackMessagingBot = new SlackMessagingBotClass(mikan.runtime, {
    appToken: slackAppToken,
    botToken: slackMessagingBotToken,
    workingDir,
    store: sharedStore,
  });
  bots.push(slackMessagingBot);
  botsByPlatform.slack = slackMessagingBot;
  log.logInfo("Platform: Slack");
}
if (hasTelegram) {
  const telegramToken = TELEGRAM_BOT_TOKEN;
  if (!telegramToken) {
    throw new Error("Telegram startup requires TELEGRAM_BOT_TOKEN");
  }
  const telegramMessagingBot = new TelegramMessagingBot(mikan.runtime, {
    token: telegramToken,
    workingDir,
  });
  bots.push(telegramMessagingBot);
  botsByPlatform.telegram = telegramMessagingBot;
  log.logInfo("Platform: Telegram");
}
if (hasDiscord) {
  const discordToken = DISCORD_BOT_TOKEN;
  if (!discordToken) {
    throw new Error("Discord startup requires DISCORD_BOT_TOKEN");
  }
  const discordMessagingBot = new DiscordMessagingBot(mikan.runtime, {
    token: discordToken,
    workingDir,
  });
  bots.push(discordMessagingBot);
  botsByPlatform.discord = discordMessagingBot;
  log.logInfo("Platform: Discord");
}

if (LINK_PORT) {
  startWebServer({
    port: LINK_PORT,
    linkTokenStore: mikan.linkTokenStore,
    vaultManager: mikan.vaultManager,
    notify: async (platform, conversationId, message) => {
      const bot = botsByPlatform[platform];
      if (bot) await bot.postMessage(conversationId, message);
    },
    sessionViewTokenStore: mikan.sessionViewTokenStore,
    sessionViewInteractive: { handler: mikan.runtime, botsByPlatform },
    adminOptions: {
      adminTokenStore: mikan.adminTokenStore,
      workingDir,
      runtime: mikan.runtime,
      sandbox,
      botsByPlatform,
    },
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
  await mikan.shutdown();
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
