#!/usr/bin/env node

import "./observability/instrument.js";

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessagingBot } from "./types.js";
import { GithubMessagingBot } from "./adapters/github/bot.js";
import { createGithubToolPack } from "./adapters/github/tool-pack.js";
import { parseGithubPolicy } from "./adapters/github/policy.js";
import type { GithubPolicy, PlatformGithubOps } from "./adapters/github/types.js";
import { TelegramMessagingBot } from "./adapters/telegram/bot.js";
import { SlackMessagingBot as SlackMessagingBotClass } from "./adapters/slack/bot.js";
import { createSlackToolPack } from "./adapters/slack/tool-pack.js";
import type { PlatformSlackOps } from "./adapters/slack/types.js";
import { SLACK_BLOCKKIT_TOOL } from "./adapters/slack/tools/blockkit.js";
import { GITHUB_CHECKS_TOOL } from "./adapters/github/tools/checks.js";
import { GITHUB_ISSUE_TOOL } from "./adapters/github/tools/issue.js";
import { GITHUB_PR_TOOL } from "./adapters/github/tools/pr.js";
import { GITHUB_READ_TOOL } from "./adapters/github/tools/read.js";
import { GITHUB_REVIEW_REPLY_TOOL } from "./adapters/github/tools/review-reply.js";
import type { PlatformToolPackFactory } from "./harness/tools/types.js";
import { downloadChannel } from "./cli/download.js";
import { EventScheduler } from "./events/scheduler.js";
import * as log from "./log.js";
import { createProcessShutdownHandler, runShutdownSteps } from "./cli/process-lifecycle.js";
import { closeWebServer, startWebServer } from "./adapters/web/server.js";
import { InMemoryAdminTokenStore } from "./adapters/web/admin/portal.js";
import { InMemoryLinkTokenStore } from "./adapters/web/login/portal.js";
import { InMemorySessionViewTokenStore } from "./adapters/web/session-view/portal.js";
import { DockerContainerManager } from "./sandbox/provisioner.js";
import { loadGlobalSettings, MissingGlobalSettingsError } from "./settings/index.js";
import { assertStateDirOutsideWorkspace } from "./file-guards.js";
import { resolveLinkBaseUrl, resolveLinkListenHost } from "./env-manifest.js";
import { configureHttpDispatcher, parseHttpIdleTimeoutMs } from "./harness/http.js";
import { defaultModelsJsonPath } from "./harness/models.js";
import { RunEventHub } from "./harness/run-events.js";
import { readEnv } from "./env-manifest.js";
import { ensureDirExists, readJsonFileIfExists } from "./file-guards.js";
import { SandboxError } from "./sandbox/utils.js";
import { validateSandbox } from "./sandbox/registry.js";
import { helpText, resolveBoot } from "./cli/boot.js";
import type { BootPlan } from "./cli/types.js";
import { runOnboardCommand } from "./cli/onboard.js";
import { envReport, noPlatformsMessage, platformIsActive } from "./env-manifest.js";
import { FileVaultManager } from "./vault/index.js";
import { runMigrateCommand } from "./cli/migrate.js";
import { runOfficeCommand } from "./cli/office.js";
import { formatPendingMigrations, pendingMigrations } from "./migrations/index.js";
import { createWorkspace } from "./office/index.js";
import { createConversationRuntime } from "./runtime/conversation-runtime.js";
import type { McpServerConfig } from "./harness/types.js";
import { captureError, shutdownObservability } from "./observability/index.js";
import { MemoryCapture } from "./memory-capture/index.js";
import { errorMessage, isRecord } from "./unknown-values.js";

function getVersion(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const possiblePaths = [
    join(moduleDir, "package.json"),
    join(dirname(moduleDir), "package.json"),
    join(process.cwd(), "package.json"),
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
const GITHUB_AGENT_TOKEN = readEnv("GITHUB_AGENT_TOKEN");
const GITHUB_WEBHOOK_SECRET = readEnv("GITHUB_WEBHOOK_SECRET");
const LINK_BASE_URL = resolveLinkBaseUrl();
const LINK_PORT_RAW = readEnv("LINK_PORT");
const LINK_PORT = LINK_PORT_RAW ? parseInt(LINK_PORT_RAW, 10) : LINK_BASE_URL ? 8181 : undefined;
const OPENCONNECTOR_ENDPOINT = readEnv("OPENCONNECTOR_ENDPOINT");
const openConnector: McpServerConfig | undefined = OPENCONNECTOR_ENDPOINT
  ? { url: OPENCONNECTOR_ENDPOINT }
  : undefined;

const WORLD_WRITABLE_MODE = 0o002;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5 * 60_000;

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

if (plan.mode === "office") {
  process.exit(runOfficeCommand(plan.officeArgs ?? []));
}

if (plan.mode === "migrate") {
  process.exit(await runMigrateCommand(plan.migrateArgs ?? []));
}

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

if (plan.mode === "onboard") {
  const stateDir = plan.stateDir;
  ensureSecureStateDir(stateDir);
  try {
    process.exit(await runOnboardCommand(stateDir));
  } catch (err) {
    console.error(errorMessage(err));
    process.exit(1);
  }
}

if (plan.mode === "download" && plan.downloadChannel) {
  if (!SLACK_BOT_TOKEN) {
    console.error("Missing env: SLACK_BOT_TOKEN");
    process.exit(1);
  }
  await downloadChannel(plan.downloadChannel, SLACK_BOT_TOKEN);
  process.exit(0);
}

const sandbox = plan.sandbox;
const stateDir = plan.stateDir;
const workingDir = plan.workingDir;
ensureSecureStateDir(stateDir);
if (!plan.workingDirExplicit) {
  ensureDirExists(workingDir);
}
try {
  assertStateDirOutsideWorkspace(stateDir, workingDir, sandbox.type);
} catch (error) {
  handleStartupError(error);
}

const hasSlack = platformIsActive("slack");
const hasTelegram = platformIsActive("telegram");
const hasDiscord = platformIsActive("discord");
const hasGithub = platformIsActive("github");

if (!hasSlack && !hasTelegram && !hasDiscord && !hasGithub) {
  console.error(noPlatformsMessage());
  process.exit(1);
}

let githubPolicy: GithubPolicy | undefined;
try {
  githubPolicy = hasGithub
    ? parseGithubPolicy({
        repos: readEnv("GITHUB_REPOS"),
        publicRepos: readEnv("GITHUB_PUBLIC_REPOS"),
        users: readEnv("GITHUB_USERS"),
        minPermission: readEnv("GITHUB_MIN_PERMISSION"),
        triggers: readEnv("GITHUB_TRIGGERS"),
        capabilities: readEnv("GITHUB_CAPABILITIES"),
      })
    : undefined;
  if (hasGithub && !LINK_PORT) {
    throw new Error("GitHub receives webhooks on the link server: set LINK_PORT and LINK_URL");
  }
} catch (error) {
  handleStartupError(error);
}

const pending = pendingMigrations(stateDir);
if (pending.length > 0) {
  console.error(formatPendingMigrations({ pending, stateDir, workspaceRoot: workingDir, sandbox }));
  process.exit(1);
}

try {
  await validateSandbox(sandbox);
} catch (error) {
  handleStartupError(error);
}

const workspace = createWorkspace({ root: workingDir, stateDir });

const vaultManager = new FileVaultManager(stateDir);
if (vaultManager.isEnabled()) {
  console.log(
    sandbox.type === "container"
      ? "  Vault system enabled. Container vault active."
      : sandbox.type === "image" || sandbox.type === "cloudflare"
        ? "  Vault system enabled. Conversation-scoped credential routing active."
        : "  Vault system enabled. Host mode will not inject vault env.",
  );
}

const startupConfig = (() => {
  try {
    return loadGlobalSettings(stateDir);
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
const resourceController = sandbox.type === "image" ? provisioner : undefined;

if (sandbox.type === "image") {
  ensureDirExists(workspace.skillsDir);
  ensureDirExists(workspace.agentsDir);
  try {
    writeFileSync(workspace.memoryPath, "", { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

const linkTokenStore = new InMemoryLinkTokenStore();
const sessionViewTokenStore = new InMemorySessionViewTokenStore();
const runEvents = new RunEventHub();
const adminTokenStore = new InMemoryAdminTokenStore();
setInterval(() => linkTokenStore.purge(), 5 * 60 * 1000).unref();
setInterval(() => sessionViewTokenStore.purge(), 5 * 60 * 1000).unref();
setInterval(() => adminTokenStore.purge(), 5 * 60 * 1000).unref();

function portalBaseUrl(): string | undefined {
  if (LINK_BASE_URL) return LINK_BASE_URL;
  if (LINK_PORT) return `http://localhost:${LINK_PORT}`;
  return undefined;
}
const MANAGED_SANDBOX_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

if (provisioner) {
  await provisioner.reconcile(workspace.root);
  await provisioner.stopIdle(MANAGED_SANDBOX_IDLE_TIMEOUT_MS);
  setInterval(
    () => provisioner.stopIdle(MANAGED_SANDBOX_IDLE_TIMEOUT_MS),
    MANAGED_SANDBOX_IDLE_TIMEOUT_MS,
  ).unref();
}

const botsByPlatform: Record<string, MessagingBot> = {};

function requireGithubBot(op: string): GithubMessagingBot {
  const bot = botsByPlatform.github as GithubMessagingBot | undefined;
  if (!bot) {
    throw new Error(`${op}: the GitHub platform is not running`);
  }
  return bot;
}

function requireSlackBot(op: string): SlackMessagingBotClass {
  const bot = botsByPlatform.slack as SlackMessagingBotClass | undefined;
  if (!bot) {
    throw new Error(`${op}: the Slack platform is not running`);
  }
  return bot;
}

function buildPlatformToolPackFactories(): PlatformToolPackFactory[] {
  const factories: PlatformToolPackFactory[] = [];
  if (hasSlack) {
    const platformSlackOps: PlatformSlackOps = {
      postBlocks: async (conversationId, { text, blocks, threadTs }) => {
        const bot = requireSlackBot(SLACK_BLOCKKIT_TOOL);
        const ts = threadTs
          ? await bot.postInThreadBlocks(conversationId, threadTs, text, blocks)
          : await bot.postMessageBlocks(conversationId, text, blocks);
        bot.logBotResponse(conversationId, text, ts, threadTs, { slackBlocks: blocks });
        return { ts };
      },
      updateBlocks: async (conversationId, { ts, text, blocks, threadTs }) => {
        const bot = requireSlackBot(SLACK_BLOCKKIT_TOOL);
        await bot.updateMessageBlocks(conversationId, ts, text, blocks);
        bot.logBotResponse(conversationId, text, ts, threadTs, { slackBlocks: blocks });
      },
      ownsBlockKitMessage: (conversationId, ts, threadTs) =>
        requireSlackBot(SLACK_BLOCKKIT_TOOL).ownsBlockKitMessage(conversationId, ts, threadTs),
    };
    factories.push(() => createSlackToolPack(platformSlackOps));
  }
  if (!githubPolicy) return factories;
  const githubCapabilities = githubPolicy.capabilities;
  const platformGithubOps: PlatformGithubOps = {
    createPullRequest: (conversationId, request) =>
      requireGithubBot(GITHUB_PR_TOOL).ops.createPullRequest(conversationId, request),
    getChecks: (conversationId, branch) =>
      requireGithubBot(GITHUB_CHECKS_TOOL).ops.getChecks(conversationId, branch),
    getJobLog: (conversationId, jobId) =>
      requireGithubBot(GITHUB_CHECKS_TOOL).ops.getJobLog(conversationId, jobId),
    replyToReviewThread: (conversationId, commentId, body) =>
      requireGithubBot(GITHUB_REVIEW_REPLY_TOOL).ops.replyToReviewThread(
        conversationId,
        commentId,
        body,
      ),
    readGithub: (conversationId, request) =>
      requireGithubBot(GITHUB_READ_TOOL).ops.readGithub(conversationId, request),
    manageIssue: (conversationId, request) =>
      requireGithubBot(GITHUB_ISSUE_TOOL).ops.manageIssue(conversationId, request),
  };
  factories.push(() => createGithubToolPack(platformGithubOps, githubCapabilities));
  return factories;
}

let eventScheduler: EventScheduler | undefined;
const handler = createConversationRuntime({
  workspace,
  eventScheduler: () => eventScheduler,
  sandbox,
  vaultManager,
  provisioner,
  resourceController,
  linkTokenStore,
  sessionViewTokenStore,
  adminTokenStore,
  openConnector,
  runEvents,
  portalBaseUrl: portalBaseUrl(),
  platformToolPackFactories: buildPlatformToolPackFactories(),
  memoryCapture: (models) => new MemoryCapture(models),
});

const sandboxDesc =
  sandbox.type === "host"
    ? "host"
    : sandbox.type === "container"
      ? `container:${sandbox.container}`
      : sandbox.type === "image"
        ? `image:${sandbox.image}`
        : `cloudflare:${sandbox.sandboxId}`;
log.logStartup(workingDir, sandboxDesc);
logHarnessStartupSummary();

function logHarnessStartupSummary(): void {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  log.logInfo(
    `HTTP dispatcher: idle timeout ${httpIdleTimeoutMs}ms${proxy ? `, proxy ${proxy}` : ", no proxy"}`,
  );

  const modelsPath = defaultModelsJsonPath(stateDir);
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
  const { DiscordMessagingBot } = await import("./adapters/discord/bot.js");
  const discordMessagingBot = new DiscordMessagingBot(handler, {
    token: discordToken,
    workspace,
  });
  botsByPlatform.discord = discordMessagingBot;
  log.logInfo("Platform: Discord");
}
if (githubPolicy && GITHUB_AGENT_TOKEN) {
  botsByPlatform.github = new GithubMessagingBot(handler, {
    token: GITHUB_AGENT_TOKEN,
    policy: githubPolicy,
    workspace,
  });
  log.logInfo("Platform: GitHub");
}

const githubBot = botsByPlatform.github as GithubMessagingBot | undefined;

const webServer = LINK_PORT
  ? startWebServer({
      port: LINK_PORT,
      host: resolveLinkListenHost(),
      linkTokenStore,
      vaultManager,
      notify: async (platform, conversationId, message) => {
        const bot = botsByPlatform[platform];
        if (bot) await bot.postMessage(conversationId, message);
      },
      sessionViewTokenStore,
      sessionViewInteractive: { handler, botsByPlatform, runEvents },
      adminOptions: {
        adminTokenStore,
        workspace,
        runtime: handler,
        sandbox,
        botsByPlatform,
        eventScheduler: () => eventScheduler,
      },
      githubWebhook:
        GITHUB_WEBHOOK_SECRET && githubBot
          ? {
              secret: GITHUB_WEBHOOK_SECRET,
              onDelivery: (delivery) => void githubBot.receive(delivery),
            }
          : undefined,
    })
  : undefined;

const WEB_SERVER_CLOSE_GRACE_MS = 5000;

function stopWebServer(): Promise<void> {
  if (!webServer) return Promise.resolve();
  return closeWebServer(webServer, WEB_SERVER_CLOSE_GRACE_MS);
}

async function stopConversationIntake(): Promise<void> {
  const results = await Promise.allSettled([
    ...Object.values(botsByPlatform).map((bot) => bot.stop()),
    stopWebServer(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Failed to stop conversation intake");
}

async function waitForGracefulDrain(drain: Promise<unknown>): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    drain.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return settled;
}

async function drainConversationWork(intakeStop: Promise<void>): Promise<void> {
  const gracefulDrain = Promise.allSettled([intakeStop]);
  if (!(await waitForGracefulDrain(gracefulDrain))) {
    const runtimeResult = await Promise.allSettled([handler.shutdown(0)]);
    const failures: unknown[] = [
      new Error(`Conversation work did not drain within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms`),
      ...runtimeResult.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    throw new AggregateError(failures, "Failed to drain conversation work");
  }

  const results = [
    ...(await gracefulDrain),
    ...(await Promise.allSettled([handler.shutdown(SHUTDOWN_DRAIN_TIMEOUT_MS)])),
  ];
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, "Failed to drain conversation work");
}

eventScheduler = new EventScheduler(workspace, botsByPlatform);
const slackMessagingBot = botsByPlatform.slack as SlackMessagingBotClass | undefined;
if (slackMessagingBot) {
  slackMessagingBot.setEventScheduler(eventScheduler);
}
eventScheduler.start();

const shutdown = createProcessShutdownHandler({
  stop: () => {
    const intakeStop = stopConversationIntake();
    return runShutdownSteps([
      {
        name: "event scheduler",
        run: async () => {
          eventScheduler?.stop();
        },
      },
      { name: "conversation work", run: () => drainConversationWork(intakeStop) },
    ]);
  },
  shutdownObservability: () => shutdownObservability(5000),
  captureError,
  warn: log.logWarning,
  exit: (code) => process.exit(code),
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await Promise.all(
  Object.values(botsByPlatform).map((bot) =>
    bot.start().catch((err) => {
      log.logWarning("Failed to start bot", errorMessage(err));
      process.exit(1);
    }),
  ),
);
