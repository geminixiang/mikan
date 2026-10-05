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
    doc: "Issue/PR conversations as a bound GitHub account, driven by webhooks (needs LINK_PORT)",
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
      {
        name: "GITHUB_REPOS",
        required: true,
        doc: "Comma-separated owner/repo or owner/* the agent answers in",
      },
      { name: "GITHUB_PUBLIC_REPOS", doc: "Answer in public repositories too (default false)" },
      { name: "GITHUB_USERS", doc: "Comma-separated logins allowed to trigger (default: anyone)" },
      {
        name: "GITHUB_MIN_PERMISSION",
        doc: "Repository permission a trigger needs: write, maintain, or admin (default write)",
      },
      {
        name: "GITHUB_TRIGGERS",
        doc: "Comma-separated mention, assign, review, followup (default all)",
      },
      {
        name: "GITHUB_CAPABILITIES",
        doc: "Comma-separated triage, push beyond commenting (default none)",
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
        doc: "OpenRouter API key (chat models routed through OpenRouter, and harness/jev.ts's Jev client via @geminixiang/jev)",
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
    key: "observability",
    title: "Observability",
    kind: "feature",
    vars: [
      { name: "SENTRY_DSN", secret: true, doc: "Sentry DSN (settings.json sentry.dsn wins)" },
      {
        name: "SENTRY_ENVIRONMENT",
        deploy: false,
        doc: "Sentry environment tag (default production)",
      },
      { name: "SENTRY_ENABLED", deploy: false, doc: "Set to false to disable Sentry errors" },
      {
        name: "SENTRY_TRACES_SAMPLE_RATE",
        deploy: false,
        doc: "Sentry trace sample rate, 0 to 1 (default 1; ignored with OTLP traces)",
      },
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
  {
    key: "runtime",
    title: "Runtime",
    kind: "feature",
    vars: [
      {
        name: "HTTP_IDLE_TIMEOUT",
        deploy: false,
        doc: "Idle timeout in ms for outbound HTTP streams",
      },
    ],
  },
];

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
