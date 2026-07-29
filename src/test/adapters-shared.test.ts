import { describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler, OfficeAddress, RunningSession } from "../adapter.js";
import { resolveOnlyScopedStopTarget, resolveStopTarget } from "../adapters/shared.js";
import { createOfficeAddress, officeKey, sameOffice } from "../office/index.js";

const slack = createOfficeAddress("slack", "C123");

function makeHandler(running: Array<{ address: OfficeAddress; sessionKey: string }>) {
  const runningIds = new Set(running.map((s) => `${officeKey(s.address)}|${s.sessionKey}`));
  const runningSessions: RunningSession[] = running.map((session, index) => ({
    address: session.address,
    sessionKey: session.sessionKey,
    startedAt: index + 1,
  }));

  return {
    isRunning: vi.fn((address: OfficeAddress, key: string) =>
      runningIds.has(`${officeKey(address)}|${key}`),
    ),
    getRunningSessions: vi.fn().mockReturnValue(runningSessions),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
    handleExtensionAction: vi.fn(),
  } satisfies MessagingEventHandler;
}

function inSlack(...sessionKeys: string[]) {
  return sessionKeys.map((sessionKey) => ({ address: slack, sessionKey }));
}

describe("shared stop-target helpers", () => {
  test("resolveStopTarget only checks explicit session key and conversation key", () => {
    const handler = makeHandler(inSlack("C123:1000.0001"));

    expect(resolveStopTarget({ handler, address: slack, sessionKey: "C123:9999.0001" })).toBeNull();
  });

  test("resolveOnlyScopedStopTarget returns the only scoped running session", () => {
    const handler = makeHandler(inSlack("C123:1000.0001"));

    expect(resolveOnlyScopedStopTarget(handler, slack)).toBe("C123:1000.0001");
  });

  test("resolveOnlyScopedStopTarget returns null when scoped session is ambiguous", () => {
    const handler = makeHandler(inSlack("C123:1000.0001", "C123:1000.0002"));

    expect(resolveOnlyScopedStopTarget(handler, slack)).toBeNull();
  });

  describe("offices on different platforms never stop each other", () => {
    // Discord snowflakes and Telegram chat ids are both bare digits, so an id
    // alone cannot identify an office.
    const discord = createOfficeAddress("discord", "900100");
    const telegram = createOfficeAddress("telegram", "900100");

    test("a running session in one office is not a stop target in the other", () => {
      const handler = makeHandler([{ address: discord, sessionKey: "900100" }]);

      expect(resolveStopTarget({ handler, address: discord })).toBe("900100");
      expect(resolveStopTarget({ handler, address: telegram })).toBeNull();
    });

    test("widening to the only scoped session stays inside its office", () => {
      const handler = makeHandler([
        { address: discord, sessionKey: "900100:11" },
        { address: telegram, sessionKey: "900100:22" },
      ]);

      expect(resolveOnlyScopedStopTarget(handler, discord)).toBe("900100:11");
      expect(resolveOnlyScopedStopTarget(handler, telegram)).toBe("900100:22");
      expect(sameOffice(discord, telegram)).toBe(false);
    });
  });
});
