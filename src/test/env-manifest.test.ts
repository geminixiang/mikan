import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  activePlatformKeys,
  ENV_MANIFEST,
  envReport,
  envSummaryLines,
  manifestVarNames,
  noPlatformsMessage,
  platformIsActive,
  resolveLinkListenHost,
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

  test("github needs the agent token, the webhook secret, and a repository allowlist", () => {
    const complete = {
      GITHUB_AGENT_TOKEN: "github_pat_x",
      GITHUB_WEBHOOK_SECRET: "hush",
      GITHUB_REPOS: "acme/*",
    };
    expect(platformIsActive("github", lookup(complete))).toBe(true);
    for (const name of Object.keys(complete)) {
      const partial = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== name));
      expect(platformIsActive("github", lookup(partial))).toBe(false);
    }
    expect(platformIsActive("github", lookup({ GITHUB_APP_ID: "1" }))).toBe(false);
  });

  test("activePlatformKeys lists exactly the active groups", () => {
    expect(activePlatformKeys(lookup({ TELEGRAM_BOT_TOKEN: "t", DISCORD_BOT_TOKEN: "d" }))).toEqual(
      ["telegram", "discord"],
    );
    expect(activePlatformKeys(lookup({}))).toEqual([]);
  });
});

describe("derived surfaces", () => {
  test("the no-platforms error names every platform group", () => {
    const message = noPlatformsMessage();
    for (const group of ENV_MANIFEST.filter((candidate) => candidate.kind === "platform")) {
      expect(message).toContain(group.title);
    }
    expect(message).toContain("SLACK_APP_TOKEN + SLACK_BOT_TOKEN");
    expect(message).toContain("GITHUB_AGENT_TOKEN + GITHUB_WEBHOOK_SECRET + GITHUB_REPOS");
  });

  test("--help embeds the platform recipes", () => {
    const help = helpText();
    for (const line of envSummaryLines()) {
      expect(help).toContain(line.trim());
    }
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
    const missing = manifestVarNames({ deployOnly: true }).filter(
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
