import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gondolinInventory } from "../src/sandbox/gondolin-inventory.js";

const OWNER_DEAD = 55001;
const OWNER_ALIVE = 55002;
const RUNNER = 55003;

describe("Gondolin runtime inventory", () => {
  let dir: string;
  let alivePids: Set<number>;
  let signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  let surviveSigterm: boolean;
  let commands: Map<number, string>;
  const gcSessions = vi.fn().mockResolvedValue(0);

  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (!alivePids.has(pid)) throw new Error("ESRCH");
    if (signal === 0) return;
    signals.push({ pid, signal });
    if (signal === "SIGKILL" || (signal === "SIGTERM" && !surviveSigterm)) {
      alivePids.delete(pid);
    }
  };

  const execFile = async (cmd: string, args: string[]): Promise<string> => {
    expect(cmd).toBe("ps");
    const pid = Number(args[1]);
    const command = commands.get(pid);
    if (!command || !alivePids.has(pid)) throw new Error("Exit code 1");
    return `${command}\n`;
  };

  function configure(): void {
    gondolinInventory.configure(dir, {
      execFile,
      kill,
      gcSessions,
      killWaitMs: 20,
      killPollIntervalMs: 1,
    });
  }

  function writeRecord(overrides: Record<string, unknown> = {}): string {
    const record = {
      sessionId: "stale-session",
      instanceId: "c1",
      ownerPid: OWNER_DEAD,
      runnerPid: RUNNER,
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    const path = join(dir, `${record.sessionId}.json`);
    writeFileSync(path, JSON.stringify(record));
    return path;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-inventory-"));
    alivePids = new Set([OWNER_ALIVE]);
    signals = [];
    surviveSigterm = false;
    commands = new Map([[RUNNER, "qemu-system-aarch64 -kernel /home/u/.cache/gondolin/kernel"]]);
    gcSessions.mockClear();
    configure();
  });

  afterEach(() => {
    gondolinInventory.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  test("records, refreshes, and releases runtime records", () => {
    gondolinInventory.record({ sessionId: "s1", instanceId: "c1", runnerPid: null });
    const path = join(dir, "s1.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      sessionId: "s1",
      instanceId: "c1",
      ownerPid: process.pid,
      runnerPid: null,
    });

    gondolinInventory.refresh("s1", 4242);
    expect(JSON.parse(readFileSync(path, "utf8")).runnerPid).toBe(4242);

    gondolinInventory.release("s1");
    expect(existsSync(path)).toBe(false);
  });

  test("reconcile stops an orphaned runner and drops its record", async () => {
    alivePids.add(RUNNER);
    const path = writeRecord();

    await gondolinInventory.reconcile();

    expect(signals).toEqual([{ pid: RUNNER, signal: "SIGTERM" }]);
    expect(alivePids.has(RUNNER)).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(gcSessions).toHaveBeenCalledOnce();
  });

  test("reconcile escalates to SIGKILL when SIGTERM is ignored", async () => {
    alivePids.add(RUNNER);
    surviveSigterm = true;
    const path = writeRecord();

    await gondolinInventory.reconcile();

    expect(signals).toEqual([
      { pid: RUNNER, signal: "SIGTERM" },
      { pid: RUNNER, signal: "SIGKILL" },
    ]);
    expect(existsSync(path)).toBe(false);
  });

  test("reconcile leaves runtimes owned by a live process alone", async () => {
    alivePids.add(RUNNER);
    const path = writeRecord({ ownerPid: OWNER_ALIVE });

    await gondolinInventory.reconcile();

    expect(signals).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test("reconcile never kills a reused pid that is no longer a Gondolin runner", async () => {
    alivePids.add(RUNNER);
    commands.set(RUNNER, "/usr/libexec/unrelated-daemon");
    const path = writeRecord();

    await gondolinInventory.reconcile();

    expect(signals).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("reconcile drops stale and malformed records idempotently", async () => {
    const gone = writeRecord({ sessionId: "gone", runnerPid: 55999 });
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{not json");

    await gondolinInventory.reconcile();
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(malformed)).toBe(false);

    await gondolinInventory.reconcile();
    expect(signals).toEqual([]);
    expect(gcSessions).toHaveBeenCalledTimes(2);
  });

  test("findAdoptable returns the newest live worker record and reaps dead ones", async () => {
    const dead = writeRecord({
      sessionId: "dead-worker",
      ownerPid: OWNER_DEAD,
      socketPath: "/sessions/dead.sock",
      fingerprint: "fp",
    });
    writeRecord({
      sessionId: "older",
      ownerPid: OWNER_ALIVE,
      socketPath: "/sessions/older.sock",
      fingerprint: "fp",
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    writeRecord({
      sessionId: "newer",
      ownerPid: OWNER_ALIVE,
      socketPath: "/sessions/newer.sock",
      fingerprint: "fp",
      createdAt: "2026-07-14T01:00:00.000Z",
    });
    writeRecord({ sessionId: "other-key", instanceId: "c2", ownerPid: OWNER_ALIVE });

    const adoptable = await gondolinInventory.findAdoptable("c1");

    expect(adoptable?.sessionId).toBe("newer");
    expect(existsSync(dead)).toBe(false);
  });

  test("listWorkerRecords only lists live worker-owned records", () => {
    writeRecord({
      sessionId: "live-worker",
      ownerPid: OWNER_ALIVE,
      socketPath: "/sessions/live.sock",
    });
    writeRecord({ sessionId: "dead-worker", ownerPid: OWNER_DEAD, socketPath: "/s.sock" });
    writeRecord({ sessionId: "in-process", ownerPid: OWNER_ALIVE });

    const records = gondolinInventory.listWorkerRecords();

    expect(records.map((record) => record.sessionId)).toEqual(["live-worker"]);
  });

  test("reapSession reaps only when the owner is gone", async () => {
    alivePids.add(RUNNER);
    const dead = writeRecord({ sessionId: "dead-owner", ownerPid: OWNER_DEAD });
    const live = writeRecord({ sessionId: "live-owner", ownerPid: OWNER_ALIVE });

    await gondolinInventory.reapSession("dead-owner");
    await gondolinInventory.reapSession("live-owner");

    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(signals).toEqual([{ pid: RUNNER, signal: "SIGTERM" }]);
  });

  test("touchHeartbeat writes the heartbeat file", () => {
    gondolinInventory.touchHeartbeat();
    const heartbeat = gondolinInventory.heartbeatPath();
    expect(heartbeat).toBe(join(dir, "heartbeat"));
    expect(existsSync(heartbeat as string)).toBe(true);
  });

  test("stays inert while unconfigured", async () => {
    gondolinInventory.configure();
    gondolinInventory.record({ sessionId: "s1", instanceId: "c1", runnerPid: 1 });
    await gondolinInventory.reconcile();
    expect(existsSync(join(dir, "s1.json"))).toBe(false);
    expect(gcSessions).not.toHaveBeenCalled();
  });
});
