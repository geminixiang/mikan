import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { COMMAND_MANIFEST } from "../adapters/commands/manifest.js";
import {
  describeSlackAppSync,
  readSlackAppCustomization,
  SLACK_APP_CUSTOMIZATION_FILE,
  SLACK_CONFIG_TOKEN_FILE,
  slackAppManifest,
  slackBotNameProblem,
  syncSlackApp,
  writeSlackAppCustomization,
} from "../adapters/slack/app-config.js";
import type { SlackAppApi, SlackBotApi } from "../adapters/slack/types.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-slack-app-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

function storeTokens() {
  writeFileSync(
    join(stateDir, SLACK_CONFIG_TOKEN_FILE),
    JSON.stringify({ token: "xoxe.xoxp-old", refresh_token: "xoxe-1-old" }),
    { mode: 0o600 },
  );
}

function fakeApps(live: unknown, permissionsUpdated = false) {
  const apps = {
    rotate: vi.fn<SlackAppApi["rotate"]>(async () => ({
      token: "xoxe.xoxp-new",
      refreshToken: "xoxe-1-new",
      userId: "U0OWNER",
    })),
    export: vi.fn<SlackAppApi["export"]>(async () => structuredClone(live)),
    update: vi.fn<SlackAppApi["update"]>(async () => ({ permissionsUpdated })),
    create: vi.fn<SlackAppApi["create"]>(),
    delete: vi.fn<SlackAppApi["delete"]>(),
  } satisfies SlackAppApi;
  return apps;
}

function fakeBot(scopes: string[]) {
  return {
    appId: vi.fn<SlackBotApi["appId"]>(async () => "A0123456789"),
    scopes: vi.fn<SlackBotApi["scopes"]>(async () => scopes),
    directMessage: vi.fn<SlackBotApi["directMessage"]>(async () => {}),
  } satisfies SlackBotApi;
}

function reorderKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorderKeys) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, inner]) => [key, reorderKeys(inner)]),
    ) as T;
  }
  return value;
}

function withoutNames(m: ReturnType<typeof slackAppManifest>) {
  return { ...m, display_information: undefined, features: { ...m.features, bot_user: undefined } };
}

describe("the built-in Slack app manifest", () => {
  test("has a slash command for every command that declares one", () => {
    const commands = slackAppManifest().features?.slash_commands?.map((c) => c.command);
    const declared = COMMAND_MANIFEST.flatMap((entry) =>
      entry.slackCommand ? [entry.slackCommand] : [],
    );
    expect(commands).toEqual(declared);
  });

  test("is the example operators copy by hand", () => {
    const example = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../deploy/examples/slack-app-manifest.json"),
        "utf8",
      ),
    );
    expect(example).toEqual(slackAppManifest());
  });

  test("customization replaces the display information it names and the bot's name", () => {
    const manifest = slackAppManifest({ display_information: { name: "Acme Bot" } });
    expect(manifest.display_information).toEqual({
      ...slackAppManifest().display_information,
      name: "Acme Bot",
    });
    expect(manifest.features?.bot_user?.display_name).toBe("Acme Bot");
    expect(withoutNames(manifest)).toEqual(withoutNames(slackAppManifest()));
  });

  test("a name Slack cannot use as a username leaves the bot named mikan", () => {
    expect(slackBotNameProblem("Pi.bot_1 -x")).toBeUndefined();
    for (const name of ["小橘", "Pi 助理", "é", "Pi!", "a".repeat(81)]) {
      expect(slackBotNameProblem(name)).toBeDefined();
      expect(
        slackAppManifest({ display_information: { name } }).features?.bot_user?.display_name,
      ).toBe("mikan");
    }
  });
});

describe("slack.json", () => {
  test("round-trips display information and refuses other fields", () => {
    writeSlackAppCustomization(stateDir, { display_information: { name: "acme-bot" } });
    expect(readSlackAppCustomization(stateDir)).toEqual({
      display_information: { name: "acme-bot" },
    });
    expect(statSync(join(stateDir, SLACK_APP_CUSTOMIZATION_FILE)).mode & 0o777).toBe(0o600);

    writeFileSync(
      join(stateDir, SLACK_APP_CUSTOMIZATION_FILE),
      JSON.stringify({ oauth_config: { scopes: { bot: ["admin"] } } }),
    );
    expect(() => readSlackAppCustomization(stateDir)).toThrow(/slack\.json/);
  });
});

describe("syncSlackApp", () => {
  test("does nothing without a stored configuration token", async () => {
    const apps = fakeApps(slackAppManifest());
    const bot = fakeBot([]);

    const result = await syncSlackApp({ stateDir, apps, bot });

    expect(result).toEqual({ status: "no-token" });
    expect(apps.rotate).not.toHaveBeenCalled();
    expect(bot.appId).not.toHaveBeenCalled();
  });

  test("rotates the token, saves it privately, and replaces a drifted app with the desired manifest", async () => {
    storeTokens();
    writeSlackAppCustomization(stateDir, { display_information: { name: "acme-bot" } });
    const drifted = slackAppManifest();
    drifted.features?.slash_commands?.pop();
    drifted.oauth_config?.scopes?.bot?.push("emoji:read");
    const apps = fakeApps(drifted);

    const result = await syncSlackApp({ stateDir, apps, bot: fakeBot([]) });

    expect(result).toEqual({ status: "updated", appId: "A0123456789", missingScopes: [] });
    expect(apps.rotate).toHaveBeenCalledWith("xoxe-1-old");
    expect(apps.update).toHaveBeenCalledWith(
      "xoxe.xoxp-new",
      "A0123456789",
      slackAppManifest({ display_information: { name: "acme-bot" } }),
    );
    const file = join(stateDir, SLACK_CONFIG_TOKEN_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      token: "xoxe.xoxp-new",
      refresh_token: "xoxe-1-new",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("leaves a matching app alone, whatever Slack's key order and defaults", async () => {
    storeTokens();
    const manifest = slackAppManifest();
    const live = reorderKeys({
      ...manifest,
      features: {
        ...manifest.features,
        app_home: { ...manifest.features?.app_home, agent_tasks_enabled: true },
      },
      settings: { ...manifest.settings, app_level_token_rotation_enabled: false },
    });
    const apps = fakeApps(live);

    const result = await syncSlackApp({ stateDir, apps, bot: fakeBot([]) });

    expect(result).toEqual({ status: "unchanged", appId: "A0123456789" });
    expect(apps.update).not.toHaveBeenCalled();
  });

  test("asks the token owner once to reinstall when the update needs scopes the bot lacks", async () => {
    storeTokens();
    const live = slackAppManifest();
    live.oauth_config!.scopes!.bot = live.oauth_config!.scopes!.bot!.filter(
      (scope) => scope !== "reactions:write",
    );
    const granted = live.oauth_config!.scopes!.bot!;
    const bot = fakeBot(granted);

    const result = await syncSlackApp({ stateDir, apps: fakeApps(live, true), bot });

    expect(result).toEqual({
      status: "updated",
      appId: "A0123456789",
      missingScopes: ["reactions:write"],
    });
    expect(bot.directMessage).toHaveBeenCalledTimes(1);
    const [userId, text] = bot.directMessage.mock.calls[0]!;
    expect(userId).toBe("U0OWNER");
    expect(text).toContain("reactions:write");
    expect(text).toContain("https://api.slack.com/apps/A0123456789/install-on-team");
  });

  test("reports a failed rotation without throwing and keeps the stored token", async () => {
    storeTokens();
    const apps = fakeApps(slackAppManifest());
    apps.rotate.mockRejectedValueOnce(new Error("invalid_refresh_token"));

    const result = await syncSlackApp({ stateDir, apps, bot: fakeBot([]) });

    expect(result).toEqual({ status: "failed", reason: "invalid_refresh_token" });
    expect(JSON.parse(readFileSync(join(stateDir, SLACK_CONFIG_TOKEN_FILE), "utf8")).token).toBe(
      "xoxe.xoxp-old",
    );
  });
});

describe("describeSlackAppSync", () => {
  test("names the outcome an operator acts on", () => {
    expect(describeSlackAppSync({ status: "no-token" })).toBeUndefined();
    expect(describeSlackAppSync({ status: "failed", reason: "invalid_refresh_token" })).toMatch(
      /failed.*invalid_refresh_token/,
    );
    expect(
      describeSlackAppSync({ status: "updated", appId: "A1", missingScopes: ["emoji:read"] }),
    ).toMatch(/reinstall.*emoji:read/);
  });
});
