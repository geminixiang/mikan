import { describe, expect, test } from "vitest";
import { parseSandboxCommand } from "../adapters/commands/sandbox.js";

describe("sandbox command parsing", () => {
  test("parses status command", () => {
    expect(parseSandboxCommand("/pi-sandbox")).toEqual({});
  });

  test("parses boost command", () => {
    expect(parseSandboxCommand("/pi-sandbox boost")).toEqual({
      action: "boost",
    });
  });

  test("parses Telegram sandbox alias", () => {
    expect(parseSandboxCommand("/sandbox@my_bot boost")).toEqual({
      action: "boost",
    });
  });

  test("does not expose bare visibility words or the retired door verb", () => {
    expect(parseSandboxCommand("/pi-sandbox private")).toEqual({});
    expect(parseSandboxCommand("/pi-sandbox full")).toEqual({});
    expect(parseSandboxCommand("/pi-sandbox door full")).toEqual({});
  });

  test("parses the visibility argument", () => {
    expect(parseSandboxCommand("/pi-sandbox visibility private")).toEqual({
      action: "visibility",
      visibility: "private",
    });
    expect(parseSandboxCommand("/pi-sandbox visibility")).toEqual({ action: "visibility" });
  });

  test("ignores other commands", () => {
    expect(parseSandboxCommand("/pi-model anthropic/claude-sonnet-4-6")).toBeNull();
  });
});
