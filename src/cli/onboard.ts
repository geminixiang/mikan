/**
 * `mikan onboard` — interactive first-run setup.
 *
 * Three questions cover the minimum viable deployment: one chat adapter,
 * one LLM provider, and an optional sandbox mode. Everything asked is
 * derived from existing authorities (ENV_MANIFEST for platform vars,
 * settings/models.json shapes from config.ts / harness/models.ts) — this
 * file adds no second inventory of anything.
 *
 * Products:
 *   - <state-dir>/settings.json        (llm section follows the choice)
 *   - <state-dir>/mikan.env  (0600)    (tokens/keys; at the default state
 *                                       dir this is the ~/.mikan/mikan.env
 *                                       the pm2 ecosystem file loads)
 *   - ~/.mikan/models.json             (custom endpoint choice only)
 *
 * Non-interactive stdin (CI, piped) falls back to writing the settings
 * template only — the pre-wizard `--onboard` behavior.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { ENV_MANIFEST, envReport, readEnv } from "../env-manifest.js";
import { createGlobalSettingsFile } from "../config.js";
import type { OnboardLlmChoice } from "../types.js";
import { defaultModelsJsonPath } from "../harness/models.js";
import { atomicWritePrivateFile } from "../utils/file-guards.js";
import type { OnboardIo } from "./types.js";

class OnboardAborted extends Error {
  constructor() {
    super("Onboarding aborted.");
  }
}

/** Terminal-backed IO; secret answers are not echoed. */
function terminalIo(): OnboardIo {
  const gate = { muted: false };
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!gate.muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  // Ctrl+D closes readline mid-question; surface it as a clean abort.
  const closed = new Promise<never>((_, reject) => {
    rl.on("close", () => reject(new OnboardAborted()));
  });
  closed.catch(() => {}); // observed via Promise.race below
  return {
    ask: (query) => Promise.race([rl.question(query), closed]),
    askSecret: async (query) => {
      process.stdout.write(query);
      gate.muted = true;
      try {
        const value = await Promise.race([rl.question(""), closed]);
        process.stdout.write("\n");
        return value;
      } finally {
        gate.muted = false;
      }
    },
    print: (line) => console.log(line),
    close: () => rl.close(),
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
  labels.forEach((label, i) => io.print(`  ${i + 1}. ${label}`));
  for (;;) {
    const raw = (await io.ask(`${prompt} [1-${labels.length}]: `)).trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= labels.length) return n - 1;
    io.print("  (enter a number from the list)");
  }
}

/** Q1: pick a platform group from the manifest and collect its vars. */
async function askAdapter(io: OnboardIo, env: Record<string, string>): Promise<void> {
  const platforms = ENV_MANIFEST.filter((group) => group.kind === "platform");
  io.print("\nStep 1/3 — chat adapter");
  const index = await askChoice(
    io,
    platforms.map((g) => g.title),
    "Platform",
  );
  const group = platforms[index]!;
  for (const spec of group.vars.filter((v) => v.required)) {
    env[spec.name] = await askRequired(io, `  ${spec.name} (${spec.doc}): `, spec.secret);
  }
  if (group.anyOf) {
    // Prefer the path form of an either/or pair (keeps PEMs out of env files).
    const name = group.anyOf.find((n) => n.endsWith("_PATH")) ?? group.anyOf[0]!;
    const doc = group.vars.find((v) => v.name === name)?.doc ?? "";
    env[name] = await askRequired(io, `  ${name} (${doc}): `);
  }
}

/** Q2: LLM provider. Returns settings llm choice; may add env vars / models.json. */
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
    const model = (await io.ask("  Model [claude-sonnet-4-6]: ")).trim() || "claude-sonnet-4-6";
    return { llm: { provider: "anthropic", model, autoReplyModel: "claude-haiku-4-5" } };
  }
  if (index === 1) {
    env.OPENAI_API_KEY = await askRequired(io, "  OPENAI_API_KEY: ", true);
    const model = (await io.ask("  Model [gpt-5.2]: ")).trim() || "gpt-5.2";
    return { llm: { provider: "openai", model } };
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
          ...(apiKey ? { apiKey } : {}),
          models: ids.map((id) => ({ id })),
        },
      },
    },
    null,
    2,
  );
  return { llm: { provider, model: ids[0]! }, modelsJson };
}

/** Q3: sandbox mode. Returns the `--sandbox` argument, or undefined for host. */
async function askSandbox(io: OnboardIo): Promise<string | undefined> {
  io.print("\nStep 3/3 — sandbox (where agent commands run)");
  const index = await askChoice(
    io,
    [
      "host — run directly on this machine (default)",
      "image — per-conversation Docker containers (needs Docker)",
      "other — configure later via --sandbox (cloudflare)",
    ],
    "Sandbox",
  );
  if (index === 0) return undefined;
  if (index === 1) {
    const image =
      (await io.ask("  Image [ghcr.io/geminixiang/mikan-sandbox:latest]: ")).trim() ||
      "ghcr.io/geminixiang/mikan-sandbox:latest";
    return `image:${image}`;
  }
  io.print("  See `mikan --help` for the --sandbox spec.");
  return undefined;
}

/** Merge collected vars into the env file, preserving unrelated existing lines. */
export function renderEnvFile(existing: string | undefined, vars: Record<string, string>): string {
  const pending = new Map(Object.entries(vars));
  const lines: string[] = [];
  for (const line of existing ? existing.split("\n") : []) {
    const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
    if (key && pending.has(key)) {
      lines.push(`${key}=${pending.get(key)}`);
      pending.delete(key);
    } else if (line.trim() || lines.length > 0) {
      lines.push(line);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return `${lines.join("\n")}\n`;
}

export async function runOnboardWizard(
  stateDir: string,
  io: OnboardIo,
  paths?: { envFilePath?: string; modelsJsonPath?: string },
): Promise<number> {
  const settingsPath = join(stateDir, "settings.json");
  if (existsSync(settingsPath)) {
    io.print(`Global settings already exists at ${settingsPath}.`);
    io.print("Remove it first to re-run onboarding, or edit it directly.");
    return 1;
  }

  const env: Record<string, string> = {};
  await askAdapter(io, env);
  const { llm, modelsJson } = await askLlm(io, env);
  const sandboxArg = await askSandbox(io);

  createGlobalSettingsFile(stateDir, llm);
  io.print(`\nWrote ${settingsPath}`);

  if (modelsJson) {
    const modelsPath = paths?.modelsJsonPath ?? defaultModelsJsonPath();
    if (existsSync(modelsPath)) {
      io.print(`models.json already exists at ${modelsPath} — add this provider manually:`);
      io.print(modelsJson);
    } else {
      atomicWritePrivateFile(modelsPath, `${modelsJson}\n`);
      io.print(`Wrote ${modelsPath}`);
    }
  }

  // Lives beside settings.json; at the default state dir this is exactly
  // the ~/.mikan/mikan.env that the pm2 ecosystem file loads.
  const envFilePath = paths?.envFilePath ?? join(stateDir, "mikan.env");
  const existing = existsSync(envFilePath) ? readFileSync(envFilePath, "utf-8") : undefined;
  atomicWritePrivateFile(envFilePath, renderEnvFile(existing, env));
  io.print(`Wrote ${envFilePath} (0600)`);

  // Report against the answers just given without mutating process.env.
  io.print(`\n${envReport((name) => env[name] ?? readEnv(name))}`);

  const sandboxFlag = sandboxArg ? ` --sandbox ${sandboxArg}` : "";
  io.print("Next steps:");
  io.print(`  pm2:    pm2 start ecosystem.config.cjs   (loads ${envFilePath}; see deploy/pm2/)`);
  io.print(`  direct: set -a; source ${envFilePath}; set +a; mikan${sandboxFlag}`);
  return 0;
}

/** Entry point for main.ts. Interactive on a TTY; template-only otherwise. */
export async function runOnboardCommand(stateDir: string): Promise<number> {
  if (!process.stdin.isTTY) {
    const settingsPath = createGlobalSettingsFile(stateDir);
    console.log(`Created global settings at ${settingsPath}`);
    console.log(
      `Review the file, then start mikan (workspace defaults to ${join(stateDir, "workspace")}).`,
    );
    return 0;
  }
  const io = terminalIo();
  try {
    return await runOnboardWizard(stateDir, io);
  } catch (err) {
    if (err instanceof OnboardAborted) {
      console.log("\nOnboarding aborted; nothing was written.");
      return 1;
    }
    throw err;
  } finally {
    io.close();
  }
}
