import { describe, expect, test } from "vitest";
import {
  COMMAND_MANIFEST,
  commandForms,
  matchCommand,
  slashForms,
  telegramCommandMenu,
} from "../commands/manifest.js";
import { commandManifestEntry, isCommandText } from "../commands/manifest.js";
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

  test("unknown command names fail loudly instead of returning nothing", () => {
    expect(() => commandManifestEntry("frobnicate")).toThrow(/Unknown command in manifest/);
    expect(() => slashForms("frobnicate")).toThrow(/Unknown command in manifest/);
    expect(() => commandForms("frobnicate")).toThrow(/Unknown command in manifest/);
  });
});

describe("matchCommand", () => {
  const aliases = ["/model", "/pi-model"] as const;

  test("tokenizes args across arbitrary whitespace", () => {
    expect(matchCommand("  /model   openai/gpt-5\tnow ", aliases)).toEqual({
      command: "/model",
      args: ["openai/gpt-5", "now"],
    });
  });

  test("matches case-insensitively and returns the normalized command", () => {
    expect(matchCommand("/MODEL arg", aliases)).toEqual({ command: "/model", args: ["arg"] });
  });

  test("empty and non-command texts return null", () => {
    expect(matchCommand("", aliases)).toBeNull();
    expect(matchCommand("   ", aliases)).toBeNull();
    expect(matchCommand("hello /model", aliases)).toBeNull();
    expect(matchCommand("/models", aliases)).toBeNull();
  });

  test("strips a bot mention only when asked to", () => {
    expect(matchCommand("/model@mikan_bot arg", aliases, { stripMention: true })).toEqual({
      command: "/model",
      args: ["arg"],
    });
    expect(matchCommand("/model@mikan_bot arg", aliases)).toBeNull();
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
