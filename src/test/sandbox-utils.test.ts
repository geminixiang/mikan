import { describe, expect, test } from "vitest";
import { SandboxError, execSimple } from "../sandbox/utils.js";

describe("SandboxError", () => {
  test("formats the message alone when there are no details", () => {
    const error = new SandboxError("boom");
    expect(error.name).toBe("SandboxError");
    expect(error.details).toEqual([]);
    expect(error.formatForCli()).toEqual(["boom"]);
  });

  test("formats each detail as its own line under the message", () => {
    expect(new SandboxError("boom", ["first", "second"]).formatForCli()).toEqual([
      "boom",
      "first",
      "second",
    ]);
  });
});

describe("execSimple", () => {
  test("resolves with stdout on success", async () => {
    await expect(execSimple("echo", ["hi"])).resolves.toBe("hi\n");
  });

  test("rejects with stderr on failure", async () => {
    await expect(execSimple("sh", ["-c", "echo bad >&2; exit 2"])).rejects.toThrow(/bad/);
  });

  test("rejects with the exit code when stderr is empty", async () => {
    await expect(execSimple("sh", ["-c", "exit 7"])).rejects.toThrow(/Exit code 7/);
  });

  test("rejects when the executable cannot be started", async () => {
    await expect(execSimple("mikan-command-that-does-not-exist", [])).rejects.toThrow(/ENOENT/);
  });
});
