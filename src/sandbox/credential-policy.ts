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

export function resolveCommandEnv(
  command: string,
  vaultEnv?: Record<string, string>,
): Record<string, string> | undefined {
  if (!vaultEnv) return undefined;

  const cli = detectCommandCli(command);
  if (!cli) return undefined;

  const env: Record<string, string> = {};
  for (const policy of CLI_ENV_POLICIES) {
    if (!policy.cliNames.includes(cli)) continue;
    for (const key of policy.envKeys) {
      if (key in vaultEnv) env[key] = vaultEnv[key];
    }
  }

  return Object.keys(env).length > 0 ? env : undefined;
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
