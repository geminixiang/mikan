import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runSlackCommand } from "../cli/slack.js";
import { resolveBoot } from "../cli/boot.js";
import {
  SLACK_APP_CUSTOMIZATION_FILE,
  SLACK_CONFIG_TOKEN_FILE,
  writeSlackAppCustomization,
} from "../adapters/slack/app-config.js";
import type { SlackAppApi } from "../adapters/slack/types.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-slack-cli-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function apps(): SlackAppApi {
  return {
    rotate: vi.fn(async () => ({
      token: "xoxe.xoxp-new",
      refreshToken: "xoxe-1-new",
      userId: "U0OWNER",
    })),
    export: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
}

const customization = () =>
  JSON.parse(readFileSync(join(stateDir, SLACK_APP_CUSTOMIZATION_FILE), "utf8"));

describe("mikan slack", () => {
  test("routes from the command line", () => {
    expect(resolveBoot(["slack", "set", "--name", "x"])).toMatchObject({
      mode: "slack",
      slackArgs: ["set", "--name", "x"],
    });
  });

  test("set writes display information to slack.json and keeps fields it does not name", async () => {
    writeSlackAppCustomization(stateDir, { display_information: { description: "kept" } });

    const code = await runSlackCommand(["set", "--name", "acme-bot"], { stateDir, apps: apps() });

    expect(code).toBe(0);
    expect(customization()).toEqual({
      display_information: { description: "kept", name: "acme-bot" },
    });
  });

  test("set refuses options outside display information and values Slack would reject", async () => {
    expect(await runSlackCommand(["set", "--scopes", "admin"], { stateDir, apps: apps() })).toBe(1);
    expect(
      await runSlackCommand(["set", "--name", "x".repeat(36)], { stateDir, apps: apps() }),
    ).toBe(1);
    expect(existsSync(join(stateDir, SLACK_APP_CUSTOMIZATION_FILE))).toBe(false);
  });

  test("token checks the refresh token with Slack and stores the rotated pair privately", async () => {
    const api = apps();

    const code = await runSlackCommand(["token"], {
      stateDir,
      apps: api,
      readSecret: async () => "xoxe-1-given",
    });

    expect(code).toBe(0);
    expect(api.rotate).toHaveBeenCalledWith("xoxe-1-given");
    const file = join(stateDir, SLACK_CONFIG_TOKEN_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      token: "xoxe.xoxp-new",
      refresh_token: "xoxe-1-new",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("token stores nothing when Slack refuses the refresh token", async () => {
    const api = apps();
    vi.mocked(api.rotate).mockRejectedValueOnce(new Error("invalid_refresh_token"));

    const code = await runSlackCommand(["token"], {
      stateDir,
      apps: api,
      readSecret: async () => "xoxe-1-bad",
    });

    expect(code).toBe(1);
    expect(existsSync(join(stateDir, SLACK_CONFIG_TOKEN_FILE))).toBe(false);
  });
});
