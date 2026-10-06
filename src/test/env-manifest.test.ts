import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ENV_MANIFEST,
  envReport,
  envSummaryLines,
  noPlatformsMessage,
  platformIsActive,
  resolveLinkListenHost,
  retiredEnvWarnings,
} from "../env-manifest.js";
import { helpText } from "../cli/boot.js";

function lookup(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name];
}

describe("platform activation", () => {
  test("slack needs both tokens", () => {
    expect(platformIsActive("slack", lookup({ SLACK_APP_TOKEN: "x" }))).toBe(false);
    expect(platformIsActive("slack", lookup({ SLACK_APP_TOKEN: "x", SLACK_BOT_TOKEN: "y" }))).toBe(
      true,
    );
  });

  test("github needs the agent token and the webhook secret", () => {
    const complete = {
      GITHUB_AGENT_TOKEN: "github_pat_x",
      GITHUB_WEBHOOK_SECRET: "hush",
    };
    expect(platformIsActive("github", lookup(complete))).toBe(true);
    for (const name of Object.keys(complete)) {
      const partial = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== name));
      expect(platformIsActive("github", lookup(partial))).toBe(false);
    }
    expect(platformIsActive("github", lookup({ GITHUB_APP_ID: "1" }))).toBe(false);
  });
});

describe("retired variables", () => {
  test("name where each moved setting now lives, under either spelling", () => {
    const warnings = retiredEnvWarnings(
      lookup({ GITHUB_REPOS: "acme/*", MIKAN_GITHUB_USERS: "alice", SLACK_BOT_TOKEN: "x" }),
    );
    expect(warnings).toEqual([
      "GITHUB_REPOS: set github.repos in ~/.mikan/settings.json",
      "MIKAN_GITHUB_USERS: set github.users in ~/.mikan/settings.json",
    ]);
  });

  test("report removed variables without a replacement", () => {
    expect(
      retiredEnvWarnings(lookup({ HTTP_IDLE_TIMEOUT: "60000", SENTRY_ENABLED: "false" })),
    ).toEqual([
      "HTTP_IDLE_TIMEOUT: removed; outbound HTTP streams time out after 5 minutes",
      "SENTRY_ENABLED: removed; leave SENTRY_DSN unset to turn Sentry off",
    ]);
  });

  test("are not listed as variables mikan reads", () => {
    const listed = new Set(ENV_MANIFEST.flatMap((group) => group.vars.map((spec) => spec.name)));
    const retired = retiredEnvWarnings((name) =>
      name.startsWith("MIKAN_") ? undefined : "set",
    ).map((warning) => warning.split(":")[0]!);
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.filter((name) => listed.has(name))).toEqual([]);
  });
});

describe("derived surfaces", () => {
  test("the no-platforms error names every platform group", () => {
    const message = noPlatformsMessage();
    for (const group of ENV_MANIFEST.filter((candidate) => candidate.kind === "platform")) {
      expect(message).toContain(group.title);
    }
    expect(message).toContain("SLACK_APP_TOKEN + SLACK_BOT_TOKEN");
    expect(message).toContain("GITHUB_AGENT_TOKEN + GITHUB_WEBHOOK_SECRET");
  });

  test("--help embeds the platform recipes", () => {
    const help = helpText();
    for (const line of envSummaryLines()) {
      expect(help).toContain(line.trim());
    }
  });

  test("lists every variable mikan reads, except Pi's own", () => {
    const readOnPisBehalf = new Set(["PI_CODING_AGENT_DIR"]);
    const listed = new Set(ENV_MANIFEST.flatMap((group) => group.vars.map((spec) => spec.name)));
    const sources = readdirSync(join(process.cwd(), "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.startsWith("test"))
      .map((file) => readFileSync(join(process.cwd(), "src", file), "utf8"));
    const read = sources.flatMap((source) =>
      [...source.matchAll(/(?:readEnv|readStandardEnv|resolveScopesFromEnv)\(\s*"([A-Z_]+)"/g)].map(
        (match) => match[1]!,
      ),
    );
    expect(read.filter((name) => !listed.has(name) && !readOnPisBehalf.has(name))).toEqual([]);
  });

  test("envReport folds the standard OTEL_* variables into one line", () => {
    const report = envReport(
      lookup({ OTEL_SERVICE_NAME: "mikan", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://x" }),
    );
    const otelLines = report.split("\n").filter((line) => line.includes("OTEL_"));
    expect(otelLines).toHaveLength(1);
    expect(otelLines[0]).toMatch(/OTEL_\*\s+2 of \d+ set/);
    expect(report).not.toContain("https://x");
  });

  test("envReport shows status without leaking values", () => {
    const report = envReport(lookup({ SLACK_APP_TOKEN: "xapp-super-secret" }));
    expect(report).toContain("SLACK_APP_TOKEN");
    expect(report).not.toContain("xapp-super-secret");
  });

  test("the deploy env-file example covers every deploy-facing var", () => {
    const example = readFileSync(
      join(process.cwd(), "deploy", "pm2", "mikan.env.example"),
      "utf-8",
    );
    const deployVars = ENV_MANIFEST.flatMap((group) =>
      group.vars.filter((spec) => spec.deploy !== false).map((spec) => spec.name),
    );
    const missing = deployVars.filter(
      (name) => !example.includes(`${name}=`) && !example.includes(`MIKAN_${name}=`),
    );
    expect(missing).toEqual([]);
  });

  test("the pm2 template holds no inline secrets, only the env-file loader", () => {
    const template = readFileSync(
      join(process.cwd(), "deploy", "pm2", "ecosystem.config.cjs"),
      "utf-8",
    );
    expect(template).toContain("mikan.env");
    expect(template).not.toMatch(/SLACK_APP_TOKEN|ANTHROPIC_API_KEY/);
  });
});

describe("link server listen host", () => {
  test("stays on loopback even when a public LINK_URL is set, so only the reverse proxy reaches it", () => {
    expect(resolveLinkListenHost(lookup({ LINK_URL: "https://mikan.example.com" }))).toBe(
      "127.0.0.1",
    );
    expect(resolveLinkListenHost(lookup({}))).toBe("127.0.0.1");
  });

  test("LINK_HOST opts into another interface", () => {
    expect(resolveLinkListenHost(lookup({ LINK_HOST: "0.0.0.0" }))).toBe("0.0.0.0");
  });
});
