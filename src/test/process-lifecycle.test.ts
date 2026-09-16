import { describe, expect, test, vi } from "vitest";
import { createProcessShutdownHandler, runShutdownSteps } from "../cli/process-lifecycle.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createOptions(
  overrides: {
    stop?: () => Promise<void>;
    shutdownObservability?: () => Promise<boolean>;
  } = {},
) {
  return {
    stop: overrides.stop ?? vi.fn().mockResolvedValue(undefined),
    shutdownObservability: overrides.shutdownObservability ?? vi.fn().mockResolvedValue(true),
    captureError: vi.fn(),
    warn: vi.fn(),
    exit: vi.fn(),
  };
}

describe("runShutdownSteps", () => {
  test("continues through later phases and reports every failure", async () => {
    const calls: string[] = [];
    const firstFailure = new Error("socket stuck");
    const lastFailure = new Error("runner stuck");

    await expect(
      runShutdownSteps([
        {
          name: "intake",
          run: async () => {
            calls.push("intake");
            throw firstFailure;
          },
        },
        { name: "scheduler", run: async () => void calls.push("scheduler") },
        {
          name: "runtime",
          run: async () => {
            calls.push("runtime");
            throw lastFailure;
          },
        },
      ]),
    ).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "intake: socket stuck", cause: firstFailure }),
        expect.objectContaining({ message: "runtime: runner stuck", cause: lastFailure }),
      ],
    });
    expect(calls).toEqual(["intake", "scheduler", "runtime"]);
  });
});

describe("createProcessShutdownHandler", () => {
  test("runs one graceful shutdown and exits successfully", async () => {
    const options = createOptions();
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGTERM");

    expect(options.stop).toHaveBeenCalledOnce();
    expect(options.shutdownObservability).toHaveBeenCalledOnce();
    expect(options.captureError).not.toHaveBeenCalled();
    expect(options.exit).toHaveBeenCalledWith(0);
  });

  test("flushes diagnostics and exits non-zero when shutdown fails", async () => {
    const failure = new Error("runner did not settle");
    const options = createOptions({ stop: vi.fn().mockRejectedValue(failure) });
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGINT");

    expect(options.captureError).toHaveBeenCalledWith(failure);
    expect(options.shutdownObservability).toHaveBeenCalledOnce();
    expect(options.warn).toHaveBeenCalledWith("Graceful shutdown failed", failure.message);
    expect(options.exit).toHaveBeenCalledWith(1);
  });

  test("names every nested step failure, not just the wrapper", async () => {
    const failure = new AggregateError(
      [
        new Error("conversation work: Conversation work did not drain within 300000ms"),
        new AggregateError(
          [new Error("Shutdown could not settle 2 aborted runs within 5000ms")],
          "Failed to drain conversation work",
        ),
      ],
      "Graceful shutdown failed",
    );
    const options = createOptions({ stop: vi.fn().mockRejectedValue(failure) });
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGINT");

    expect(options.warn).toHaveBeenCalledWith(
      "Graceful shutdown failed",
      "Graceful shutdown failed: conversation work: Conversation work did not drain within 300000ms; Failed to drain conversation work: Shutdown could not settle 2 aborted runs within 5000ms",
    );
  });

  test("exits non-zero when observability shutdown times out", async () => {
    const options = createOptions({
      shutdownObservability: vi.fn().mockResolvedValue(false),
    });
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGTERM");

    expect(options.warn).toHaveBeenCalledWith("Observability shutdown timed out");
    expect(options.exit).toHaveBeenCalledWith(1);
  });

  test("exits non-zero when observability shutdown fails", async () => {
    const options = createOptions({
      shutdownObservability: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const shutdown = createProcessShutdownHandler(options);

    await shutdown("SIGTERM");

    expect(options.warn).toHaveBeenCalledWith("Observability shutdown failed", "offline");
    expect(options.exit).toHaveBeenCalledWith(1);
  });

  test("forces a non-zero exit on a second signal without starting shutdown twice", async () => {
    const gate = createDeferred();
    const options = createOptions({ stop: vi.fn(() => gate.promise) });
    const shutdown = createProcessShutdownHandler(options);

    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(options.stop).toHaveBeenCalledOnce();
    expect(options.warn).toHaveBeenCalledWith("Received SIGINT during shutdown; forcing exit");
    expect(options.exit).toHaveBeenCalledTimes(1);
    expect(options.exit).toHaveBeenCalledWith(1);

    gate.resolve();
    await first;
    expect(options.shutdownObservability).toHaveBeenCalledOnce();
    expect(options.exit).toHaveBeenCalledTimes(1);
  });
});
