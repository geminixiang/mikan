import * as prompts from "@clack/prompts";
import {
  readSlackAppCustomization,
  slackAppApi,
  writeConfigTokens,
  writeSlackAppCustomization,
} from "../adapters/slack/app-config.js";
import type { SlackAppApi, SlackAppCustomization } from "../adapters/slack/types.js";
import { errorMessage } from "../unknown-values.js";
import { cliCommand, commandExitCode, stateDirPath } from "./arg-grammar.js";

interface SlackCommandDeps {
  stateDir: string;
  apps: SlackAppApi;
  readSecret: (message: string) => Promise<string>;
}

interface SetOptions {
  name?: string;
  description?: string;
  longDescription?: string;
  backgroundColor?: string;
}

const REFRESH_TOKEN_PROMPT =
  "Refresh token from api.slack.com/apps > Your App Configuration Tokens (xoxe-1-…)";

async function readSecretLine(message: string): Promise<string> {
  if (process.stdin.isTTY) {
    const value = await prompts.password({ message });
    return prompts.isCancel(value) ? "" : value;
  }
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return (
    input
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

async function storeToken(deps: SlackCommandDeps): Promise<number> {
  const refreshToken = (await deps.readSecret(REFRESH_TOKEN_PROMPT)).trim();
  if (!refreshToken) {
    console.error("No refresh token given; nothing was stored.");
    return 1;
  }
  try {
    writeConfigTokens(deps.stateDir, await deps.apps.rotate(refreshToken));
  } catch (error) {
    console.error(`Slack refused the refresh token (${errorMessage(error)}); nothing was stored.`);
    return 1;
  }
  console.log("Stored. mikan applies its Slack app configuration on its next start.");
  return 0;
}

function setDisplay(stateDir: string, options: SetOptions): number {
  const current = readSlackAppCustomization(stateDir);
  const next: SlackAppCustomization = {
    ...current,
    display_information: {
      ...current.display_information,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.longDescription === undefined
        ? {}
        : { long_description: options.longDescription }),
      ...(options.backgroundColor === undefined
        ? {}
        : { background_color: options.backgroundColor }),
    },
  };
  try {
    writeSlackAppCustomization(stateDir, next);
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
  console.log("Saved slack.json. mikan applies it to the Slack app on its next start.");
  return 0;
}

export async function runSlackCommand(
  argv: string[],
  overrides: Partial<SlackCommandDeps> = {},
): Promise<number> {
  const deps: SlackCommandDeps = {
    stateDir: overrides.stateDir ?? stateDirPath(),
    apps: overrides.apps ?? slackAppApi(),
    readSecret: overrides.readSecret ?? readSecretLine,
  };
  const command = cliCommand("mikan slack").description(
    "Configure the Slack app that mikan keeps in sync on start",
  );
  let result = 1;
  command
    .command("token")
    .description("Store a Slack app configuration token so mikan can update the app")
    .action(async () => {
      result = await storeToken(deps);
    });
  command
    .command("set")
    .description("Customize the app's name and description (saved in slack.json)")
    .option("--name <name>", "App name, up to 35 characters")
    .option("--description <text>", "Short description, up to 140 characters")
    .option("--long-description <text>", "Long description, up to 4000 characters")
    .option("--background-color <hex>", "Background color such as #4d5673")
    .action((options: SetOptions) => {
      result = setDisplay(deps.stateDir, options);
    });
  try {
    await command.parseAsync(argv, { from: "user" });
    return result;
  } catch (error) {
    return commandExitCode(error, command);
  }
}
