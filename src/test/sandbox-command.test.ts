import { describe, expect, test } from "vitest";
import { parseSandboxCommand } from "../commands/sandbox.js";

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

  test("does not expose workspace door mutations through chat", () => {
    expect(parseSandboxCommand("/pi-sandbox private")).toEqual({});
    expect(parseSandboxCommand("/pi-sandbox full")).toEqual({});
  });

  test("ignores other commands", () => {
    expect(parseSandboxCommand("/pi-model anthropic/claude-sonnet-4-6")).toBeNull();
  });
});
