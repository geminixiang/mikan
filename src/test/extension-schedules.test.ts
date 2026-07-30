import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExtensionCallbackScheduler } from "../extension-schedules.js";
import type { ExtensionScheduleCallbackFire } from "../harness/index.js";
import { createOfficeAddress, officeStateDir } from "../office/index.js";

const address = createOfficeAddress("slack", "C123");

let stateDir: string;
let schedulers: ExtensionCallbackScheduler[];

function createScheduler(onFire?: (fire: ExtensionScheduleCallbackFire) => Promise<boolean>) {
  const fires: ExtensionScheduleCallbackFire[] = [];
  const scheduler = new ExtensionCallbackScheduler({
    stateDir,
    dispatch:
      onFire ??
      (async (fire) => {
        fires.push(fire);
        return true;
      }),
  });
  schedulers.push(scheduler);
  return { scheduler, fires };
}

function schedulesDir(): string {
  return join(officeStateDir(stateDir, address), "extension-schedules");
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-ext-sched-"));
  schedulers = [];
});

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ExtensionCallbackScheduler", () => {
  test("upsert persists under the office state dir and list/delete round-trip", async () => {
    const { scheduler } = createScheduler();
    await scheduler.upsert(address, "agent-pm", "boards", {
      type: "periodic",
      schedule: "30 9 * * *",
      timezone: "Asia/Taipei",
      callback: "process-boards",
      args: { boardId: 7 },
    });

    expect(readdirSync(schedulesDir())).toEqual(["agent-pm.boards.json"]);
    expect(await scheduler.list(address, "agent-pm")).toEqual([
      {
        name: "boards",
        spec: {
          type: "periodic",
          schedule: "30 9 * * *",
          timezone: "Asia/Taipei",
          callback: "process-boards",
          args: { boardId: 7 },
        },
      },
    ]);
    // Another slug sees nothing.
    expect(await scheduler.list(address, "other")).toEqual([]);

    expect(await scheduler.delete(address, "agent-pm", "boards")).toBe(true);
    expect(await scheduler.delete(address, "agent-pm", "boards")).toBe(false);
    expect(readdirSync(schedulesDir())).toEqual([]);
  });

  test("upsert rejects invalid cron patterns and past one-shots without persisting", async () => {
    const { scheduler } = createScheduler();
    await expect(
      scheduler.upsert(address, "agent-pm", "bad", {
        type: "periodic",
        schedule: "not a cron",
        timezone: "Asia/Taipei",
        callback: "cb",
      }),
    ).rejects.toThrow();
    await expect(
      scheduler.upsert(address, "agent-pm", "past", {
        type: "one-shot",
        at: "2001-01-01T00:00:00Z",
        callback: "cb",
      }),
    ).rejects.toThrow(/future/);
    await expect(
      scheduler.upsert(address, "agent-pm", "malformed", {
        type: "one-shot",
        at: "tomorrow",
        callback: "cb",
      }),
    ).rejects.toThrow(/ISO 8601/);
    expect(existsSync(schedulesDir())).toBe(false);
  });

  test("a periodic schedule fires with the stored payload", async () => {
    const { scheduler, fires } = createScheduler();
    await scheduler.upsert(address, "agent-pm", "tick", {
      type: "periodic",
      // Every second: fast enough to observe with real timers.
      schedule: "* * * * * *",
      timezone: "UTC",
      callback: "on-tick",
      args: ["a", 1],
    });

    await vi.waitFor(() => expect(fires.length).toBeGreaterThan(0), { timeout: 2500 });
    expect(fires[0]).toEqual({
      platform: "slack",
      conversationId: "C123",
      slug: "agent-pm",
      scheduleName: "tick",
      callback: "on-tick",
      args: ["a", 1],
    });
  });

  test("a fired one-shot deletes its file and never fires again", async () => {
    const { scheduler, fires } = createScheduler();
    await scheduler.upsert(address, "agent-pm", "once", {
      type: "one-shot",
      at: new Date(Date.now() + 1000).toISOString(),
      callback: "kickoff",
    });
    expect(readdirSync(schedulesDir())).toEqual(["agent-pm.once.json"]);

    await vi.waitFor(() => expect(fires).toHaveLength(1), { timeout: 3000 });
    expect(readdirSync(schedulesDir())).toEqual([]);
  });

  test("start() re-arms persisted schedules and skips malformed files", async () => {
    const { scheduler: writer } = createScheduler();
    await writer.upsert(address, "agent-pm", "tick", {
      type: "periodic",
      schedule: "* * * * * *",
      timezone: "UTC",
      callback: "on-tick",
    });
    writer.stop();
    writeFileSync(join(schedulesDir(), "agent-pm.broken.json"), "{not json");

    const { scheduler: rebooted, fires } = createScheduler();
    rebooted.start();
    await vi.waitFor(() => expect(fires.length).toBeGreaterThan(0), { timeout: 2500 });
    expect(fires[0]?.scheduleName).toBe("tick");
    // The malformed file is skipped but never deleted.
    expect(existsSync(join(schedulesDir(), "agent-pm.broken.json"))).toBe(true);
  });

  test("start() drops one-shots that expired while the process was down", async () => {
    mkdirSync(schedulesDir(), { recursive: true });
    const stale = join(schedulesDir(), "agent-pm.stale.json");
    writeFileSync(
      stale,
      JSON.stringify({
        platform: "slack",
        conversationId: "C123",
        slug: "agent-pm",
        name: "stale",
        type: "one-shot",
        at: "2001-01-01T00:00:00Z",
        callback: "kickoff",
      }),
    );

    const { scheduler, fires } = createScheduler();
    scheduler.start();
    expect(existsSync(stale)).toBe(false);
    expect(fires).toHaveLength(0);
  });
});
