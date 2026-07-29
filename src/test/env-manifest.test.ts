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

  test("github needs ids plus one private-key form", () => {
    const base = { GITHUB_APP_ID: "1", GITHUB_INSTALLATION_ID: "2" };
    expect(platformIsActive("github", lookup(base))).toBe(false);
    expect(platformIsActive("github", lookup({ ...base, GITHUB_APP_PRIVATE_KEY: "pem" }))).toBe(
      true,
    );
    expect(
      platformIsActive("github", lookup({ ...base, GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" })),
    ).toBe(true);
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
    expect(message).toContain("GITHUB_APP_PRIVATE_KEY | GITHUB_APP_PRIVATE_KEY_PATH");
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
    // No env block enumerating tokens inline — that's the env file's job.
    expect(template).not.toMatch(/SLACK_APP_TOKEN|ANTHROPIC_API_KEY/);
  });
});
