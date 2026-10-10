import { describe, expect, test } from "vitest";
import { SandboxError, execSimple, linkAbortSignal } from "../sandbox/utils.js";

describe("linkAbortSignal", () => {
  test("is inert without a signal", () => {
    let fired = 0;
    const unlink = linkAbortSignal(undefined, () => fired++);
    expect(fired).toBe(0);
    expect(() => unlink()).not.toThrow();
    expect(fired).toBe(0);
  });

  test("fires immediately for an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    let fired = 0;

    const unlink = linkAbortSignal(controller.signal, () => fired++);

    expect(fired).toBe(1);
    expect(() => unlink()).not.toThrow();
    expect(fired).toBe(1);
  });

  test("forwards an abort that arrives later", () => {
    const controller = new AbortController();
    let fired = 0;

    linkAbortSignal(controller.signal, () => fired++);
    expect(fired).toBe(0);

    controller.abort();
    expect(fired).toBe(1);
  });

  test("unlinking drops the listener, so a later abort is ignored", () => {
    const controller = new AbortController();
    let fired = 0;

    const unlink = linkAbortSignal(controller.signal, () => fired++);
    unlink();
    controller.abort();

    expect(fired).toBe(0);
  });
});

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
