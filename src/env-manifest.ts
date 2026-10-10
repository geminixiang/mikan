import type { EnvGroup } from "./types.js";

export function readEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (raw) return raw;

  const prefixed = process.env[`MIKAN_${name}`]?.trim();
  return prefixed || undefined;
}

export function readStandardEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
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
    doc: "Issue/PR conversations as a bound GitHub account, driven by webhooks (needs LINK_PORT and github.repos in settings.json)",
    vars: [
      {
        name: "GITHUB_AGENT_TOKEN",
        required: true,
        secret: true,
        doc: "Fine-grained PAT of the agent account; mikan acts on GitHub only as it",
      },
      {
        name: "GITHUB_WEBHOOK_SECRET",
        required: true,
        secret: true,
        doc: "Secret of the webhook that delivers to <LINK_URL>/github/webhook",
      },
    ],
  },
  {
    key: "llm",
    title: "LLM providers",
    kind: "feature",
    vars: [
      { name: "ANTHROPIC_API_KEY", secret: true, doc: "Anthropic API key" },
      { name: "OPENAI_API_KEY", secret: true, doc: "OpenAI API key" },
      {
        name: "OPENROUTER_API_KEY",
        secret: true,
        doc: "OpenRouter API key (chat models routed through OpenRouter, and Jev's first choice in harness/jev.ts)",
      },
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
      {
        name: "LINK_HOST",
        doc: "Listen address (default 127.0.0.1, for a reverse proxy on the same host)",
      },
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
      {
        name: "GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES",
        doc: "Scopes /login requests for Google Workspace (space-separated)",
      },
      {
        name: "GOOGLE_CLOUD_SDK_OAUTH_SCOPES",
        doc: "Scopes /login requests for Google Cloud SDK (space-separated)",
      },
      {
        name: "GITHUB_OAUTH_SCOPES",
        doc: "Scopes /login requests from GitHub (default repo read:user user:email read:org gist)",
      },
      {
        name: "OAUTH_SERVICES_JSON",
        secret: true,
        doc: "JSON array of extra OAuth services offered by /login",
      },
    ],
  },
  {
    key: "openconnector",
    title: "OpenConnector",
    kind: "feature",
    doc: "Default open-connector MCP server and the admin token that mints per-conversation runtime tokens",
    vars: [
      {
        name: "OPENCONNECTOR_ENDPOINT",
        doc: "Default MCP endpoint used when a conversation does not declare open-connector",
      },
      {
        name: "OPENCONNECTOR_ADMIN_TOKEN",
        secret: true,
        doc: "Host-only admin token used to mint one runtime token per conversation for the default server",
      },
    ],
  },
  {
    key: "sandbox",
    title: "Sandbox",
    kind: "feature",
    vars: [
      {
        name: "CONTAINER_ENGINE",
        doc: "Override the container engine for container:* and image:* sandboxes; by default mikan uses the first of nerdctl, podman, docker that answers `info`",
      },
    ],
  },
  {
    key: "observability",
    title: "Observability",
    kind: "feature",
    vars: [
      { name: "SENTRY_DSN", secret: true, doc: "Sentry DSN; Sentry is off while it is unset" },
      {
        name: "SENTRY_ENVIRONMENT",
        deploy: false,
        doc: "Sentry environment tag (default production)",
      },
      {
        name: "SENTRY_TRACES_SAMPLE_RATE",
        deploy: false,
        doc: "Sentry trace sample rate, 0 to 1 (default 1; ignored with OTLP traces)",
      },
    ],
  },
  {
    key: "otel",
    title: "OpenTelemetry",
    kind: "feature",
    folded: true,
    doc: "Standard OTEL_* exporter variables; mikan sends OTLP over HTTP/protobuf",
    vars: [
      { name: "OTEL_SDK_DISABLED", doc: "Set to true to disable OpenTelemetry" },
      { name: "OTEL_SERVICE_NAME", doc: "OTLP service name (default mikan)" },
      {
        name: "OTEL_RESOURCE_ATTRIBUTES",
        secret: true,
        doc: "Comma-separated safe resource attrs",
      },
      { name: "OTEL_TRACES_EXPORTER", doc: "Trace exporter: otlp or none" },
      { name: "OTEL_METRICS_EXPORTER", doc: "Metrics exporter: otlp or none" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", secret: true, doc: "Base OTLP HTTP endpoint" },
      { name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", secret: true, doc: "OTLP traces endpoint" },
      { name: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", secret: true, doc: "OTLP metrics endpoint" },
      { name: "OTEL_EXPORTER_OTLP_HEADERS", secret: true, doc: "Shared OTLP auth headers" },
      { name: "OTEL_EXPORTER_OTLP_TRACES_HEADERS", secret: true, doc: "OTLP trace headers" },
      { name: "OTEL_EXPORTER_OTLP_METRICS_HEADERS", secret: true, doc: "OTLP metric headers" },
      { name: "OTEL_EXPORTER_OTLP_PROTOCOL", doc: "OTLP protocol; http/protobuf supported" },
      { name: "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", doc: "Trace protocol override" },
      { name: "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", doc: "Metric protocol override" },
      { name: "OTEL_EXPORTER_OTLP_TIMEOUT", doc: "Shared OTLP timeout in milliseconds" },
      { name: "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", doc: "Trace timeout in milliseconds" },
      { name: "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT", doc: "Metric timeout in milliseconds" },
      { name: "OTEL_METRIC_EXPORT_INTERVAL", doc: "Metric export interval in milliseconds" },
      { name: "OTEL_METRIC_EXPORT_TIMEOUT", doc: "Metric export timeout in milliseconds" },
    ],
  },
];

function movedToSettings(key: string): string {
  return `set ${key} in ~/.mikan/settings.json`;
}

const NO_GITHUB_APP = "removed; GitHub runs as the account of GITHUB_AGENT_TOKEN";

const RETIRED_ENV: readonly { name: string; note: string }[] = [
  { name: "GITHUB_REPOS", note: movedToSettings("github.repos") },
  { name: "GITHUB_PUBLIC_REPOS", note: movedToSettings("github.publicRepos") },
  { name: "GITHUB_USERS", note: movedToSettings("github.users") },
  {
    name: "GITHUB_MIN_PERMISSION",
    note: movedToSettings("github.minPermission"),
  },
  { name: "GITHUB_TRIGGERS", note: movedToSettings("github.triggers") },
  {
    name: "GITHUB_CAPABILITIES",
    note: movedToSettings("github.capabilities"),
  },
  { name: "GITHUB_APP_ID", note: NO_GITHUB_APP },
  { name: "GITHUB_APP_PRIVATE_KEY_PATH", note: NO_GITHUB_APP },
  { name: "GITHUB_INSTALLATION_ID", note: NO_GITHUB_APP },
  {
    name: "HTTP_IDLE_TIMEOUT",
    note: "removed; outbound HTTP streams time out after 5 minutes",
  },
  { name: "SENTRY_ENABLED", note: "removed; leave SENTRY_DSN unset to turn Sentry off" },
  { name: "STATE_DIR", note: "removed; state always lives in ~/.mikan" },
  { name: "CLOUDFLARE_SANDBOX_URL", note: "removed with the cloudflare sandbox" },
  { name: "CLOUDFLARE_SANDBOX_TOKEN", note: "removed with the cloudflare sandbox" },
];

export function retiredEnvWarnings(
  env: (name: string) => string | undefined = (name) => process.env[name]?.trim() || undefined,
): string[] {
  return RETIRED_ENV.flatMap(({ name, note }) =>
    [name, `MIKAN_${name}`]
      .filter((spelling) => env(spelling))
      .map((spelling) => `${spelling}: ${note}`),
  );
}

type EnvLookup = (name: string) => string | undefined;

export function platformIsActive(key: string, env: EnvLookup = readEnv): boolean {
  const group = ENV_MANIFEST.find((candidate) => candidate.key === key);
  if (!group) throw new Error(`Unknown env-manifest group: ${key}`);
  return group.vars.filter((spec) => spec.required).every((spec) => env(spec.name));
}

function platformRecipe(group: EnvGroup): string {
  const required = group.vars.filter((spec) => spec.required).map((spec) => spec.name);
  return `${group.title}: ${required.join(" + ")}`;
}

export function noPlatformsMessage(): string {
  const recipes = ENV_MANIFEST.filter((group) => group.kind === "platform")
    .map((group) => `  ${platformRecipe(group)}`)
    .join("\n");
  return `No platform tokens found. Set one of:\n${recipes}`;
}

export function envSummaryLines(): string[] {
  return ENV_MANIFEST.filter((group) => group.kind === "platform").map(
    (group) => `  ${platformRecipe(group)}`,
  );
}

export function envReport(env: EnvLookup = readEnv): string {
  const lines: string[] = [];
  for (const group of ENV_MANIFEST) {
    const active =
      group.kind === "platform"
        ? platformIsActive(group.key, env)
          ? " — active"
          : " — inactive"
        : "";
    if (group.folded) {
      const set = group.vars.filter((spec) => env(spec.name)).length;
      const pattern = `${group.vars[0]!.name.split("_")[0]}_*`;
      lines.push(group.title);
      lines.push(`  ${pattern.padEnd(36)} ${set} of ${group.vars.length} set  ${group.doc ?? ""}`);
      lines.push("");
      continue;
    }
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

export function envSetReport(env: EnvLookup = readEnv): string {
  const set = ENV_MANIFEST.flatMap((group) => group.vars).filter((spec) => env(spec.name));
  return [
    "Variables set:",
    ...set.map((spec) => `  ${spec.name.padEnd(36)} ${spec.doc}`),
    "Run `mikan env` to see every variable mikan reads.",
  ].join("\n");
}

export function resolveLinkListenHost(
  read: (name: string) => string | undefined = readEnv,
): string {
  return read("LINK_HOST") ?? "127.0.0.1";
}

export function resolveLinkBaseUrl(): string | undefined {
  const raw = readEnv("LINK_URL");
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}
