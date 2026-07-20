import { describe, expect, test, vi } from "vitest";
import { shutdownRuntime } from "../src/runtime/shutdown.js";

describe("runtime shutdown", () => {
  test("releases Gondolin coordinator ownership only after control and telemetry close", async () => {
    const order: string[] = [];
    const options = {
      shutdownHandler: vi.fn(async () => {
        order.push("handler");
      }),
      stopEvents: vi.fn(() => {
        order.push("events");
      }),
      disconnectGondolinRuntimes: vi.fn(async () => {
        order.push("runtimes");
      }),
      flushTelemetry: vi.fn(async () => {
        order.push("telemetry");
      }),
      releaseGondolinCoordinator: vi.fn(() => {
        order.push("release");
      }),
      exit: vi.fn(() => {
        order.push("exit");
      }),
    };

    await shutdownRuntime(options);

    expect(order).toEqual(["handler", "events", "runtimes", "telemetry", "release", "exit"]);
    expect(options.exit).toHaveBeenCalledWith(0);
  });

  test("does not release authority when runtime disconnect is uncertain", async () => {
    const release = vi.fn();
    await expect(
      shutdownRuntime({
        shutdownHandler: async () => {},
        stopEvents: () => {},
        disconnectGondolinRuntimes: async () => {
          throw new Error("disconnect failed");
        },
        flushTelemetry: async () => {},
        releaseGondolinCoordinator: release,
        exit: vi.fn(),
      }),
    ).rejects.toThrow("disconnect failed");

    expect(release).not.toHaveBeenCalled();
  });
});
