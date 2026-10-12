import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as prompts from "@clack/prompts";
import { ENV_MANIFEST, envSetReport, readEnv } from "../env-manifest.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import { recordAllMigrations } from "../migrations/index.js";
import type { OnboardLlmChoice } from "../types.js";
import { atomicWritePrivateFile } from "../file-guards.js";
import {
  MINIMAL_SANDBOX_IMAGE,
  PM2_ECOSYSTEM_FILENAME,
  renderPm2Ecosystem,
} from "./pm2-ecosystem.js";
import { PUBLISHED_SANDBOX_SPEC } from "../sandbox/registry.js";
import { publishedSandboxImage } from "../sandbox/published-image.js";
import type { OnboardIo } from "./types.js";
import {
  createSlackApp,
  slackAppApi,
  slackAppCustomizationProblem,
  writeConfigTokens,
  writeSlackAppCustomization,
} from "../adapters/slack/app-config.js";
import type {
  SlackAppApi,
  SlackAppCustomization,
  SlackConfigTokens,
} from "../adapters/slack/types.js";

interface CreatedSlackApp {
  appId: string;
  tokens: SlackConfigTokens;
  customization: SlackAppCustomization;
}

interface AdapterAnswers {
  githubRepos?: string[];
  slackApp?: CreatedSlackApp;
  cancelled?: boolean;
}

class OnboardAborted extends Error {
  constructor() {
    super("Onboarding aborted.");
  }
}

async function answer<T>(result: Promise<T>): Promise<Exclude<T, symbol>> {
  const value = await result;
  if (prompts.isCancel(value)) throw new OnboardAborted();
  return value as Exclude<T, symbol>;
}

function terminalIo(): OnboardIo {
  return {
    ask: (message) => answer(prompts.text({ message: message.trim() })),
    askSecret: (message) => answer(prompts.password({ message: message.trim() })),
    select: (message, labels) =>
      answer(
        prompts.select({
          message,
          options: labels.map((label, value) => ({ label, value })),
        }),
      ),
    confirm: (message) => answer(prompts.confirm({ message, initialValue: true })),
    print: (line) => prompts.log.info(line.trim()),
    close: () => {},
  };
}

async function askRequired(io: OnboardIo, query: string, secret = false): Promise<string> {
  for (;;) {
    const value = (secret ? await io.askSecret(query) : await io.ask(query)).trim();
    if (value) return value;
    io.print("  (required)");
  }
}

async function askChoice(io: OnboardIo, labels: string[], prompt: string): Promise<number> {
  return io.select(prompt, labels);
}

async function askSlackDisplay(io: OnboardIo): Promise<SlackAppCustomization> {
  for (;;) {
    const name = (await io.ask("  App name [mikan]: ")).trim();
    const description = (await io.ask("  Short description [mikan Slack assistant]: ")).trim();
    const display_information = {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
    const customization = Object.keys(display_information).length ? { display_information } : {};
    const problem = slackAppCustomizationProblem(customization);
    if (!problem) return customization;
    io.print(`  ${problem}`);
  }
}

async function createSlackAppInteractively(
  io: OnboardIo,
  env: Record<string, string>,
  apps: SlackAppApi,
): Promise<AdapterAnswers> {
  io.print(
    "  Open https://api.slack.com/apps, find Your App Configuration Tokens at the bottom, generate a token for your workspace, and copy its Refresh Token. mikan keeps it to update the app when you upgrade.",
  );
  const refreshToken = await askRequired(io, "  Configuration refresh token (xoxe-1-…): ", true);
  const customization = await askSlackDisplay(io);
  const name = customization.display_information?.name ?? "mikan";
  if (!(await io.confirm(`Create the Slack app "${name}" now?`))) return { cancelled: true };
  const created = await createSlackApp({ apps, refreshToken, customization });
  io.print(`  Created Slack app ${created.appId}. Two steps Slack only offers in its web pages:`);
  io.print(
    `  1. Install it: ${created.installUrl}\n     Approve, then copy the Bot User OAuth Token (xoxb-…) from OAuth & Permissions.`,
  );
  io.print(
    `  2. Create its Socket Mode token: https://api.slack.com/apps/${created.appId}/general\n     Under App-Level Tokens, generate a token with the connections:write scope and copy it (xapp-…).`,
  );
  env.SLACK_BOT_TOKEN = await askRequired(io, "  SLACK_BOT_TOKEN (xoxb-…): ", true);
  env.SLACK_APP_TOKEN = await askRequired(io, "  SLACK_APP_TOKEN (xapp-…): ", true);
  return { slackApp: { appId: created.appId, tokens: created.tokens, customization } };
}

async function askAdapter(
  io: OnboardIo,
  env: Record<string, string>,
  apps: SlackAppApi,
): Promise<AdapterAnswers> {
  const platforms = ENV_MANIFEST.filter((group) => group.kind === "platform");
  io.print("\nStep 1/3 — chat adapter");
  const index = await askChoice(
    io,
    platforms.map((g) => g.title),
    "Platform",
  );
  const group = platforms[index]!;
  if (group.key === "slack") {
    const create = await askChoice(
      io,
      [
        "Create a new Slack app for me (needs a Slack configuration token)",
        "Use a Slack app I already created",
      ],
      "Slack app",
    );
    if (create === 0) return createSlackAppInteractively(io, env, apps);
    io.print("  Later, `mikan slack token` lets mikan keep this app configured when you upgrade.");
  }
  for (const spec of group.vars.filter((v) => v.required)) {
    env[spec.name] = await askRequired(io, `  ${spec.name} (${spec.doc}): `, spec.secret);
  }
  if (group.key !== "github") return {};
  const repos = await askRequired(io, "  Repositories (owner/repo or owner/*, comma-separated): ");
  return {
    githubRepos: repos
      .split(",")
      .map((repo) => repo.trim())
      .filter(Boolean),
  };
}

async function askLlm(
  io: OnboardIo,
  env: Record<string, string>,
): Promise<{ llm: OnboardLlmChoice; modelsJson?: string }> {
  io.print("\nStep 2/3 — LLM provider");
  const index = await askChoice(
    io,
    [
      "Anthropic (ANTHROPIC_API_KEY)",
      "OpenAI (OPENAI_API_KEY)",
      "Custom OpenAI-compatible endpoint (vLLM, proxy, …) — writes models.json",
    ],
    "Provider",
  );
  if (index === 0) {
    env.ANTHROPIC_API_KEY = await askRequired(io, "  ANTHROPIC_API_KEY: ", true);
    return { llm: { provider: "anthropic", model: "claude-sonnet-4-6" } };
  }
  if (index === 1) {
    env.OPENAI_API_KEY = await askRequired(io, "  OPENAI_API_KEY: ", true);
    return { llm: { provider: "openai", model: "gpt-5.2" } };
  }
  const provider = (await io.ask("  Provider name [custom]: ")).trim() || "custom";
  const baseUrl = await askRequired(io, "  Base URL (e.g. http://host:8080/v1): ");
  const apiKey = (await io.askSecret("  API key (empty if none): ")).trim();
  const ids = (await askRequired(io, "  Model ids (comma-separated): "))
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const modelsJson = JSON.stringify(
    {
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl,
          apiKey: apiKey ? apiKey : undefined,
          models: ids.map((id) => ({ id })),
        },
      },
    },
    null,
    2,
  );
  return { llm: { provider, model: ids[0]! }, modelsJson };
}

async function askSandboxSpec(io: OnboardIo): Promise<string> {
  io.print(
    "\nStep 3/3 — sandbox image (one container per conversation; needs nerdctl, Podman, or Docker)",
  );
  const index = await askChoice(
    io,
    [
      `${publishedSandboxImage()} (recommended: git, gh, gcloud, node, python, browser; follows mikan upgrades)`,
      `${MINIMAL_SANDBOX_IMAGE} (minimal: shell only, no git or package installs)`,
      "Another image from Docker Hub or a registry…",
    ],
    "Sandbox image",
  );
  if (index === 0) return PUBLISHED_SANDBOX_SPEC;
  if (index === 1) return `oci:${MINIMAL_SANDBOX_IMAGE}`;
  return `oci:${await askRequired(io, "  Image (e.g. registry/name:tag): ")}`;
}

export function renderEnvFile(existing: string | undefined, vars: Record<string, string>): string {
  const pending = new Map(Object.entries(vars));
  const lines: string[] = [];
  for (const line of existing ? existing.split("\n") : []) {
    const rendered = rewriteEnvLine(line, pending);
    if (rendered.trim() || lines.length > 0) lines.push(rendered);
  }
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

function rewriteEnvLine(line: string, pending: Map<string, string>): string {
  const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
  if (key === undefined || !pending.has(key)) return line;
  const value = pending.get(key);
  pending.delete(key);
  return `${key}=${value}`;
}

export async function runOnboardWizard(
  stateDir: string,
  io: OnboardIo,
  paths?: { envFilePath?: string },
  deps: { slackApps?: SlackAppApi } = {},
): Promise<number> {
  const settingsPath = join(stateDir, "settings.json");
  if (existsSync(settingsPath)) {
    io.print(`Global settings already exists at ${settingsPath}.`);
    io.print("Remove it first to re-run onboarding, or edit it directly.");
    return 1;
  }

  const env: Record<string, string> = {};
  const apps = deps.slackApps ?? slackAppApi();
  const adapter = await askAdapter(io, env, apps);
  if (adapter.cancelled) {
    io.print("Onboarding cancelled; nothing was created or written.");
    return 1;
  }
  const { slackApp } = adapter;
  try {
    const code = await finishOnboarding(stateDir, io, env, adapter, paths);
    if (code !== 0) await discardSlackApp(io, apps, slackApp);
    return code;
  } catch (error) {
    await discardSlackApp(io, apps, slackApp);
    throw error;
  }
}

async function discardSlackApp(
  io: OnboardIo,
  apps: SlackAppApi,
  slackApp: CreatedSlackApp | undefined,
): Promise<void> {
  if (!slackApp) return;
  await apps.delete(slackApp.tokens.token, slackApp.appId);
  io.print(`Deleted the Slack app ${slackApp.appId} created during onboarding.`);
}

async function finishOnboarding(
  stateDir: string,
  io: OnboardIo,
  env: Record<string, string>,
  { githubRepos, slackApp }: AdapterAnswers,
  paths?: { envFilePath?: string },
): Promise<number> {
  const settingsPath = join(stateDir, "settings.json");
  const { llm, modelsJson } = await askLlm(io, env);
  const sandboxSpec = await askSandboxSpec(io);

  const modelsPath = join(stateDir, "models.json");
  if (modelsJson && existsSync(modelsPath)) {
    io.print(
      `models.json already exists at ${modelsPath}. Add the provider manually before retrying; nothing was written.`,
    );
    return 1;
  }
  io.print(
    `Review settings\nProvider: ${llm.provider}\nModel: ${llm.model}\nSandbox: ${sandboxSpec}\nSettings: ${settingsPath}\nCredentials: ${paths?.envFilePath ?? join(stateDir, "mikan.env")}${modelsJson ? `\nModels: ${modelsPath}` : ""}\nSecrets are hidden.`,
  );
  if (!(await io.confirm("Save these settings?"))) {
    io.print("Onboarding cancelled; nothing was written.");
    return 1;
  }

  createGlobalSettingsFile(stateDir, { llm, githubRepos });
  recordAllMigrations(stateDir);
  io.print(`\nWrote ${settingsPath}`);

  if (slackApp) {
    writeConfigTokens(stateDir, slackApp.tokens);
    if (slackApp.customization.display_information) {
      writeSlackAppCustomization(stateDir, slackApp.customization);
    }
    io.print(`Wrote the Slack configuration token and app settings to ${stateDir}`);
  }

  if (modelsJson) {
    atomicWritePrivateFile(modelsPath, `${modelsJson}\n`);
    io.print(`Wrote ${modelsPath}`);
  }

  const envFilePath = paths?.envFilePath ?? join(stateDir, "mikan.env");
  const existing = existsSync(envFilePath) ? readFileSync(envFilePath, "utf-8") : undefined;
  atomicWritePrivateFile(envFilePath, renderEnvFile(existing, env));
  io.print(`Wrote ${envFilePath} (0600)`);

  io.print(`\n${envSetReport((name) => env[name] ?? readEnv(name))}`);

  const ecosystemPath = join(stateDir, PM2_ECOSYSTEM_FILENAME);
  if (existsSync(ecosystemPath)) {
    io.print(`Kept existing ${ecosystemPath}`);
  } else {
    atomicWritePrivateFile(ecosystemPath, renderPm2Ecosystem(sandboxSpec));
    io.print(`Wrote ${ecosystemPath}`);
  }

  io.print("Next steps:");
  io.print(`  pm2 start ${ecosystemPath} && pm2 save`);
  io.print(
    `  Foreground instead: set -a; source ${envFilePath}; set +a; mikan --sandbox=${sandboxSpec}`,
  );
  io.print("  mikan pulls the sandbox image on start.");
  return 0;
}

export async function runOnboardCommand(stateDir: string): Promise<number> {
  if (!process.stdin.isTTY) {
    const settingsPath = createGlobalSettingsFile(stateDir);
    recordAllMigrations(stateDir);
    console.log(`Created global settings at ${settingsPath}`);
    console.log(
      `Review the file, then start mikan (workspace defaults to ${join(stateDir, "workspace")}).`,
    );
    return 0;
  }
  prompts.intro("Mikan setup · arrows to choose · Esc / Ctrl+C to cancel");
  const io = terminalIo();
  try {
    const code = await runOnboardWizard(stateDir, io);
    prompts.outro(code === 0 ? "Setup complete" : "Setup not saved");
    return code;
  } catch (err) {
    if (err instanceof OnboardAborted) {
      prompts.cancel("Onboarding aborted; nothing was written.");
      return 1;
    }
    throw err;
  } finally {
    io.close();
  }
}
