import type { EnvExposurePolicy } from "./types.js";

interface CliEnvPolicy {
  cliNames: string[];
  envKeys: string[];
}

const CLI_ENV_POLICIES: CliEnvPolicy[] = [
  {
    cliNames: ["gh"],
    envKeys: ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_OAUTH_ACCESS_TOKEN"],
  },
  {
    cliNames: ["gcloud", "gsutil", "bq"],
    envKeys: [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "CLOUDSDK_CONFIG",
    ],
  },
  {
    cliNames: ["wrangler"],
    envKeys: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  },
  {
    cliNames: ["vercel"],
    envKeys: ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"],
  },
  {
    cliNames: ["sentry-cli"],
    envKeys: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"],
  },
];

const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);
const DLX_RUNNERS = new Set(["pnpm", "yarn"]);
const KNOWN_CLI_ENV_KEYS = new Set(CLI_ENV_POLICIES.flatMap((policy) => policy.envKeys));

/**
 * CLI names the credential policy recognizes, sorted for stable UI rendering.
 * The login portal renders these as suggested command groups so the web
 * exposure picker stays in sync with the injection logic in this module.
 */
export const KNOWN_CLI_NAMES: string[] = [
  ...new Set(CLI_ENV_POLICIES.flatMap((policy) => policy.cliNames)),
].toSorted((left, right) => left.localeCompare(right));

export function resolveCommandEnv(
  command: string,
  vaultEnv?: Record<string, string>,
  envPolicy: EnvExposurePolicy = {},
): Record<string, string> | undefined {
  if (!vaultEnv) return undefined;

  const cli = detectCommandCli(command);
  const allowedKeys = resolveAllowedEnvKeys(cli, vaultEnv, envPolicy);
  const env: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (key in vaultEnv) env[key] = vaultEnv[key];
  }

  return Object.keys(env).length > 0 ? env : undefined;
}

export function defaultEnvExposurePolicyForKeys(envKeys: string[]): EnvExposurePolicy {
  const always: string[] = [];
  const commandsByCli: Record<string, string[]> = {};
  for (const envKey of envKeys) {
    const commands = defaultCommandsForKnownEnvKey(envKey);
    if (commands.length === 0) {
      always.push(envKey);
      continue;
    }
    for (const command of commands) {
      commandsByCli[command] = [...(commandsByCli[command] ?? []), envKey];
    }
  }
  return normalizeEnvExposurePolicy({ always, commands: commandsByCli });
}

export function normalizeEnvExposurePolicy(policy: EnvExposurePolicy): EnvExposurePolicy {
  const always = [...new Set(policy.always ?? [])]
    .filter(isValidEnvKey)
    .toSorted((left, right) => left.localeCompare(right));
  const commandEntries: Array<[string, string[]]> = [];
  for (const [rawCommand, envKeys] of Object.entries(policy.commands ?? {})) {
    const command = normalizeCliName(rawCommand.trim());
    const normalizedEnvKeys = [...new Set(envKeys)]
      .filter(isValidEnvKey)
      .toSorted((left, right) => left.localeCompare(right));
    if (command && normalizedEnvKeys.length > 0) commandEntries.push([command, normalizedEnvKeys]);
  }
  const commands = Object.fromEntries(
    commandEntries.toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return { always, commands };
}

function resolveAllowedEnvKeys(
  cli: string | undefined,
  vaultEnv: Record<string, string>,
  envPolicy: EnvExposurePolicy,
): Set<string> {
  const allowed = new Set<string>();
  const explicitlyConfigured = collectConfiguredEnvKeys(envPolicy);

  for (const key of envPolicy.always ?? []) allowed.add(key);
  if (cli) {
    for (const key of envPolicy.commands?.[cli] ?? []) allowed.add(key);
  }

  for (const key of Object.keys(vaultEnv)) {
    if (explicitlyConfigured.has(key)) continue;
    const commands = defaultCommandsForKnownEnvKey(key);
    if (commands.length === 0 || (cli && commands.includes(cli))) allowed.add(key);
  }

  return allowed;
}

function collectConfiguredEnvKeys(envPolicy: EnvExposurePolicy): Set<string> {
  const keys = new Set(envPolicy.always ?? []);
  for (const envKeys of Object.values(envPolicy.commands ?? {})) {
    for (const envKey of envKeys) keys.add(envKey);
  }
  return keys;
}

function defaultCommandsForKnownEnvKey(envKey: string): string[] {
  if (!KNOWN_CLI_ENV_KEYS.has(envKey)) return [];

  const commands = new Set<string>();
  for (const policy of CLI_ENV_POLICIES) {
    if (!policy.envKeys.includes(envKey)) continue;
    for (const cliName of policy.cliNames) commands.add(cliName);
  }
  return [...commands];
}

function detectCommandCli(command: string): string | undefined {
  const tokens = tokenizeCommandPrefix(command.trimStart());
  if (tokens.length === 0) return undefined;

  if (tokens[0] === "command" && tokens[1]) return normalizeCliName(tokens[1]);
  if (PACKAGE_RUNNERS.has(tokens[0]) && tokens[1]) return normalizeCliName(tokens[1]);
  if (DLX_RUNNERS.has(tokens[0]) && tokens[1] === "dlx" && tokens[2]) {
    return normalizeCliName(tokens[2]);
  }

  return normalizeCliName(tokens[0]);
}

function tokenizeCommandPrefix(command: string): string[] {
  const tokens: string[] = [];
  const matches = command.matchAll(/(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/g);
  for (const match of matches) {
    if (match.index !== undefined) {
      const between = command.slice(0, match.index).trim();
      if (between.length > 0 && tokens.length === 0) break;
    }
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    if (tokens.length >= 3) break;
  }
  return tokens.filter(Boolean);
}

function normalizeCliName(token: string): string {
  return token.split("/").pop() ?? token;
}

function isValidEnvKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
