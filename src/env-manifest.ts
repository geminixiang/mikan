/**
 * The daemon's environment interface, declared as data — the one inventory
 * that startup validation, `mikan env`, `--help`, and the pm2 deploy
 * template check all derive from. Add a var here and every derived surface
 * picks it up; a var read anywhere else but not listed here is a bug.
 *
 * Names are the un-prefixed spelling; `readEnv` accepts a `MIKAN_`-prefixed
 * alias for each. Not covered: dynamic OAuth service keys from
 * OAUTH_SERVICES_JSON (data-driven by design) and standard proxy vars
 * (HTTPS_PROXY/HTTP_PROXY/NO_PROXY).
 */
import { readEnv } from "./utils/env.js";

interface EnvVarSpec {
  name: string;
  /** Required for a platform group to activate. */
  required?: boolean;
  secret?: boolean;
  /** False for niche knobs that the deploy template doesn't enumerate. */
  deploy?: boolean;
  doc: string;
}

export interface EnvGroup {
  key: string;
  title: string;
  /** Platform groups start chat adapters; feature groups are optional. */
  kind: "platform" | "feature";
  vars: EnvVarSpec[];
  /** Additional activation requirement: at least one of these must be set. */
  anyOf?: readonly string[];
  doc?: string;
}

export const ENV_MANIFEST: readonly EnvGroup[] = [
  {
    key: "slack",
    title: "Slack",
    kind: "platform",
    vars: [
      {
        name: "SLACK_APP_TOKEN",
        required: true,
        secret: true,
        doc: "Socket-mode app token (xapp-…)",
      },
      { name: "SLACK_BOT_TOKEN", required: true, secret: true, doc: "Bot token (xoxb-…)" },
    ],
  },
  {
    key: "telegram",
    title: "Telegram",
    kind: "platform",
    vars: [{ name: "TELEGRAM_BOT_TOKEN", required: true, secret: true, doc: "BotFather token" }],
  },
  {
    key: "discord",
    title: "Discord",
    kind: "platform",
    vars: [{ name: "DISCORD_BOT_TOKEN", required: true, secret: true, doc: "Bot token" }],
  },
  {
    key: "github",
    title: "GitHub",
    kind: "platform",
    doc: "Issue/PR conversations via a GitHub App (polling, no webhook)",
    vars: [
      { name: "GITHUB_APP_ID", required: true, doc: "GitHub App id" },
      { name: "GITHUB_INSTALLATION_ID", required: true, doc: "App installation id" },
      {
        name: "GITHUB_APP_PRIVATE_KEY_PATH",
        doc: "Path to the App private key .pem (preferred; keep outside any repo)",
      },
      {
        name: "GITHUB_APP_PRIVATE_KEY",
        secret: true,
        deploy: false,
        doc: "App private key PEM with literal \\n newlines (fallback)",
      },
      {
        name: "GITHUB_REPOS",
        doc: "Comma-separated owner/repo allowlist (default: all installed)",
      },
      { name: "GITHUB_POLL_INTERVAL", doc: "Poll interval in seconds (default 60)" },
    ],
    anyOf: ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH"],
  },
  {
    key: "llm",
    title: "LLM providers",
    kind: "feature",
    doc: "Provider keys can also live in <state-dir>/auth.json",
    vars: [
      { name: "ANTHROPIC_API_KEY", secret: true, doc: "Anthropic API key" },
      { name: "OPENAI_API_KEY", secret: true, doc: "OpenAI API key" },
    ],
  },
  {
    key: "link",
    title: "Link/OAuth server",
    kind: "feature",
    doc: "Credential onboarding links, session view, and the Admin portal",
    vars: [
      { name: "LINK_URL", doc: "Externally visible base URL, e.g. https://mikan.example.com" },
      { name: "LINK_PORT", doc: "Listen port (default 8181 when LINK_URL is set)" },
      { name: "GITHUB_OAUTH_CLIENT_ID", doc: "GitHub OAuth app for /login linking" },
      { name: "GITHUB_OAUTH_CLIENT_SECRET", secret: true, doc: "GitHub OAuth app secret" },
      { name: "GOOGLE_WORKSPACE_CLI_CLIENT_ID", doc: "Google Workspace OAuth client for /login" },
      {
        name: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
        secret: true,
        doc: "Google Workspace OAuth secret",
      },
      { name: "GOOGLE_CLOUD_SDK_CLIENT_ID", doc: "Google Cloud SDK OAuth client for /login" },
      {
        name: "GOOGLE_CLOUD_SDK_CLIENT_SECRET",
        secret: true,
        doc: "Google Cloud SDK OAuth secret",
      },
    ],
  },
  {
    key: "cloudbuild",
    title: "Cloud Build logs",
    kind: "feature",
    doc: "Host-side GCP credentials unlock Cloud Build logs in github_checks",
    vars: [
      {
        name: "GOOGLE_APPLICATION_CREDENTIALS",
        doc: "Path to a GCP credentials file (e.g. WIF external_account)",
      },
      { name: "GOOGLE_CLOUD_PROJECT", doc: "Fallback GCP project id" },
    ],
  },
  {
    key: "cloudflare",
    title: "Remote task executor",
    kind: "feature",
    doc: "Enables the remote_task tool; the bridge worker runs each call in a throwaway sandbox",
    vars: [
      { name: "CLOUDFLARE_SANDBOX_URL", doc: "Bridge worker URL" },
      { name: "CLOUDFLARE_SANDBOX_TOKEN", secret: true, doc: "Bridge worker auth token" },
      {
        name: "CLOUDFLARE_SANDBOX_CWD",
        deploy: false,
        doc: "Working directory for a remote task (default /workspace)",
      },
    ],
  },
  {
    key: "observability",
    title: "Observability",
    kind: "feature",
    vars: [
      { name: "SENTRY_DSN", doc: "Sentry DSN (settings.json sentry.dsn wins over this)" },
      {
        name: "SENTRY_ENVIRONMENT",
        deploy: false,
        doc: "Sentry environment tag (default production)",
      },
      { name: "SENTRY_ENABLED", deploy: false, doc: "Set to false to disable Sentry" },
    ],
  },
  {
    key: "runtime",
    title: "Runtime",
    kind: "feature",
    vars: [
      { name: "STATE_DIR", deploy: false, doc: "State dir override (same as --state-dir)" },
      {
        name: "HTTP_IDLE_TIMEOUT",
        deploy: false,
        doc: "Idle timeout in ms for outbound HTTP streams",
      },
      {
        name: "AGENT_EVENTS_TOKEN",
        secret: true,
        deploy: false,
        doc: "Bearer token guarding the agent-events stream",
      },
    ],
  },
];

type EnvLookup = (name: string) => string | undefined;

function groupByKey(key: string): EnvGroup {
  const group = ENV_MANIFEST.find((candidate) => candidate.key === key);
  if (!group) throw new Error(`Unknown env-manifest group: ${key}`);
  return group;
}

/** A platform group activates when all required vars (and one anyOf) are set. */
export function platformIsActive(key: string, env: EnvLookup = readEnv): boolean {
  const group = groupByKey(key);
  const required = group.vars.filter((spec) => spec.required);
  if (!required.every((spec) => env(spec.name))) return false;
  if (group.anyOf && !group.anyOf.some((name) => env(name))) return false;
  return true;
}

export function activePlatformKeys(env: EnvLookup = readEnv): string[] {
  return ENV_MANIFEST.filter(
    (group) => group.kind === "platform" && platformIsActive(group.key, env),
  ).map((group) => group.key);
}

/** One line per platform group: the vars an operator must set to activate it. */
function platformRecipe(group: EnvGroup): string {
  const required = group.vars.filter((spec) => spec.required).map((spec) => spec.name);
  const alternative = group.anyOf ? ` + ${group.anyOf.join(" | ")}` : "";
  return `${group.title}: ${required.join(" + ")}${alternative}`;
}

export function noPlatformsMessage(): string {
  const recipes = ENV_MANIFEST.filter((group) => group.kind === "platform")
    .map((group) => `  ${platformRecipe(group)}`)
    .join("\n");
  return `No platform tokens found. Set one of:\n${recipes}`;
}

/** The `--help` environment section, derived from the platform groups. */
export function envSummaryLines(): string[] {
  return ENV_MANIFEST.filter((group) => group.kind === "platform").map(
    (group) => `  ${platformRecipe(group)}`,
  );
}

/** Every var an operator may set; `deployOnly` filters to template-listed ones. */
export function manifestVarNames(options?: { deployOnly?: boolean }): string[] {
  return ENV_MANIFEST.flatMap((group) =>
    group.vars
      .filter((spec) => !options?.deployOnly || spec.deploy !== false)
      .map((spec) => spec.name),
  );
}

/** `mikan env` output: every group and var with set/unset status. No values. */
export function envReport(env: EnvLookup = readEnv): string {
  const lines: string[] = [];
  for (const group of ENV_MANIFEST) {
    const active =
      group.kind === "platform"
        ? platformIsActive(group.key, env)
          ? " — active"
          : " — inactive"
        : "";
    lines.push(`${group.title}${active}${group.doc ? ` · ${group.doc}` : ""}`);
    for (const spec of group.vars) {
      const status = env(spec.name) ? "set" : "unset";
      const marks = [spec.required ? "required" : "", spec.secret ? "secret" : ""]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `  ${spec.name.padEnd(36)} ${status.padEnd(6)}${marks ? ` [${marks}]` : ""}  ${spec.doc}`,
      );
    }
    lines.push("");
  }
  lines.push("Each var also accepts a MIKAN_-prefixed alias (e.g. MIKAN_LINK_URL).");
  return lines.join("\n");
}
