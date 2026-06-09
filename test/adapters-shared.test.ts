import { describe, expect, test, vi } from "vitest";
import type { BotHandler, RunningSession } from "../packages/mikan/src/adapter.js";
import {
  resolveOnlyScopedStopTarget,
  resolveStopTarget,
} from "../packages/mikan/src/adapters/shared.js";

function makeHandler(runningKeys: string[] = []): BotHandler {
  const running = new Set(runningKeys);
  const runningSessions: RunningSession[] = runningKeys.map((sessionKey, index) => ({
    sessionKey,
    startedAt: index + 1,
  }));

  return {
    isRunning: vi.fn((key: string) => running.has(key)),
    getRunningSessions: vi.fn().mockReturnValue(runningSessions),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
  };
}

describe("shared stop-target helpers", () => {
  test("resolveStopTarget only checks explicit session key and conversation key", () => {
    const handler = makeHandler(["C123:1000.0001"]);

    expect(
      resolveStopTarget({
        handler,
        conversationId: "C123",
        sessionKey: "C123:9999.0001",
      }),
    ).toBeNull();
  });

  test("resolveOnlyScopedStopTarget returns the only scoped running session", () => {
    const handler = makeHandler(["C123:1000.0001"]);

    expect(resolveOnlyScopedStopTarget(handler, "C123")).toBe("C123:1000.0001");
  });

  test("resolveOnlyScopedStopTarget returns null when scoped session is ambiguous", () => {
    const handler = makeHandler(["C123:1000.0001", "C123:1000.0002"]);

    expect(resolveOnlyScopedStopTarget(handler, "C123")).toBeNull();
  });
});
