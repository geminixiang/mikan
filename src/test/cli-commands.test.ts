import { afterEach, describe, expect, test, vi } from "vitest";
import { runOfficeCommand } from "../cli/office.js";
import { runSessionsCommand } from "../cli/sessions.js";

afterEach(() => vi.restoreAllMocks());

describe("Commander subcommands", () => {
  test.each([["--help"], ["list", "--help"], ["claim", "--help"]])(
    "office help succeeds without running an action: %j",
    async (...args) => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      expect(runOfficeCommand(args)).toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
    },
  );

  test.each([
    ["claim", "C123"],
    ["list", "extra"],
    ["list", "--state-dir"],
    ["list", "--unknown"],
  ])("office rejects invalid arguments: %j", (...args) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runOfficeCommand(args)).toBe(1);
  });

  test("sessions migrate help is generated from its options", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runSessionsCommand(["migrate", "--help"])).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("--dry-run"));
  });

  test.each([["migrate", "extra"], ["migrate", "--workspace"], ["unknown"]])(
    "sessions rejects invalid arguments: %j",
    async (...args) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await runSessionsCommand(args)).toBe(1);
    },
  );
});
