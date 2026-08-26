import { describe, expect, test } from "vitest";
import {
  COMMAND_MANIFEST,
  commandForms,
  slashForms,
  telegramCommandMenu,
} from "../commands/manifest.js";
import { isCommandText } from "../commands/manifest.js";
import { defaultCommandHandlers } from "../commands/registry.js";

describe("command manifest", () => {
  test("isCommandText accepts every manifest name in slash and pi- form", () => {
    for (const entry of COMMAND_MANIFEST) {
      for (const spelling of [entry.name, ...(entry.aliases ?? [])]) {
        expect(isCommandText(`/${spelling}`), `/${spelling}`).toBe(true);
        expect(isCommandText(`/pi-${spelling}`), `/pi-${spelling}`).toBe(true);
        expect(isCommandText(`/${spelling}@mikan_bot`), `/${spelling}@bot`).toBe(true);
        expect(isCommandText(`/${spelling} arg`), `/${spelling} arg`).toBe(true);
      }
    }
    expect(isCommandText("hello /login")).toBe(false);
    expect(isCommandText("/loginish")).toBe(false);
  });

  test("session is the only bare command (per CONTEXT.md)", () => {
    expect(COMMAND_MANIFEST.filter((entry) => entry.bare).map((entry) => entry.name)).toEqual([
      "session",
    ]);
    expect(commandForms("session")).toContain("session");
    expect(commandForms("login")).not.toContain("login");
  });

  test("stop is registration-only: a magic word, never a Slack slash command", () => {
    const stop = COMMAND_MANIFEST.find((entry) => entry.name === "stop");
    expect(stop?.magicWord).toBe(true);
    expect(stop?.slackCommand).toBeUndefined();
    expect(stop?.slackRoute).toBeUndefined();
  });

  test("telegram menu derives from manifest order and overrides", () => {
    const menu = telegramCommandMenu();
    expect(menu).toEqual([
      { command: "login", description: "Store credentials in your private vault" },
      { command: "session", description: "Open the current session in the web viewer" },
      { command: "model", description: "Switch this conversation's LLM model" },
      { command: "sandbox", description: "Show or boost sandbox limits" },
      { command: "stop", description: "Stop ongoing conversation" },
      { command: "new", description: "Reset conversation history and start fresh" },
    ]);
  });

  test("slash forms include aliases in both plain and pi- spellings", () => {
    expect(slashForms("auto-reply")).toEqual([
      "/auto-reply",
      "/pi-auto-reply",
      "/autoreply",
      "/pi-autoreply",
    ]);
  });

  test("every slack slash command name is the pi- form of its entry name", () => {
    for (const entry of COMMAND_MANIFEST) {
      if (entry.slackCommand) {
        expect(entry.slackCommand).toBe(`/pi-${entry.name}`);
      }
    }
  });
});

describe("manifest-to-handler completeness", () => {
  test("every non-magic-word manifest entry constructs a handler", () => {
    // A manifest entry without a handler used to register on every platform
    // and then dispatch into silence; defaultCommandHandlers now throws at
    // construction for that case, so simply constructing is the assertion.
    const handlers = defaultCommandHandlers();
    expect(handlers).toHaveLength(COMMAND_MANIFEST.filter((entry) => !entry.magicWord).length);
  });
});
