import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runGondolinWorker, type GondolinWorkerConfig } from "../src/sandbox/gondolin-worker.js";
import { gondolinInventory } from "../src/sandbox/gondolin-inventory.js";

function createFakeVm() {
  return {
    id: "vm-1",
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getHostPid: vi.fn().mockReturnValue(777),
  };
}

describe("Gondolin worker runtime", () => {
  let dir: string;
  let vm: ReturnType<typeof createFakeVm>;
  let created: object[];
  let announced: string[];
  let exitCodes: number[];
  const signalSnapshot = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();

  const loadGondolin = async () =>
    ({
      VM: {
        create: vi.fn(async (options: object) => {
          created.push(options);
          return vm;
        }),
      },
      RealFSProvider: class {
        constructor(public source: string) {}
      },
      findSession: vi.fn(async (id: string) => ({
        id,
        pid: process.pid,
        socketPath: join(dir, `${id}.sock`),
        createdAt: new Date().toISOString(),
        alive: true,
      })),
    }) as never;

  function config(overrides: Partial<GondolinWorkerConfig> = {}): GondolinWorkerConfig {
    return {
      instanceId: "c1",
      image: "/images/mikan",
      mounts: [{ source: "/host", target: "/workspace" }],
      fingerprint: "fp-1",
      inventoryDir: dir,
      heartbeatStaleMs: 0,
      ...overrides,
    };
  }

  function run(overrides: Partial<GondolinWorkerConfig> = {}): Promise<void> {
    return runGondolinWorker(config(overrides), {
      loadGondolin,
      announce: (line) => announced.push(line),
      exit: (code) => exitCodes.push(code),
      pollIntervalMs: 5,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-worker-"));
    vm = createFakeVm();
    created = [];
    announced = [];
    exitCodes = [];
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      signalSnapshot.set(signal, process.listeners(signal) as NodeJS.SignalsListener[]);
    }
  });

  afterEach(async () => {
    // stop any watchdog still running, then restore foreign signal listeners
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitCodes.length).toBeGreaterThan(0));
    for (const [signal, listeners] of signalSnapshot) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener as NodeJS.SignalsListener)) {
          process.removeListener(signal, listener);
        }
      }
    }
    gondolinInventory.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  test("boots the VM, records the runtime, and announces readiness", async () => {
    await run();

    expect(vm.start).toHaveBeenCalledOnce();
    expect(created[0]).toMatchObject({
      sandbox: { imagePath: "/images/mikan" },
      sessionLabel: "mikan:c1",
    });
    expect(JSON.parse(announced[0])).toMatchObject({
      ready: true,
      sessionId: "vm-1",
      workerPid: process.pid,
      runnerPid: 777,
    });
    const record = JSON.parse(readFileSync(join(dir, "vm-1.json"), "utf8"));
    expect(record).toMatchObject({
      sessionId: "vm-1",
      instanceId: "c1",
      ownerPid: process.pid,
      runnerPid: 777,
      fingerprint: "fp-1",
    });
    expect(record.socketPath).toContain("vm-1.sock");
  });

  test("shuts down cleanly on SIGTERM", async () => {
    await run();

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
    expect(vm.close).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "vm-1.json"))).toBe(false);
  });

  test("exits when the VM runner dies", async () => {
    await run();

    vm.getHostPid.mockReturnValue(null);
    await vi.waitFor(() => expect(exitCodes).toEqual([1]));
    expect(vm.close).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "vm-1.json"))).toBe(false);
  });

  test("refreshes the record when the runner pid changes", async () => {
    await run();

    vm.getHostPid.mockReturnValue(888);
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(join(dir, "vm-1.json"), "utf8"));
      expect(record.runnerPid).toBe(888);
    });
  });

  test("self-stops once the mikan heartbeat goes stale", async () => {
    await run({ heartbeatStaleMs: 40 });

    await vi.waitFor(() => expect(exitCodes).toEqual([0]), { timeout: 2000 });
    expect(vm.close).toHaveBeenCalledOnce();
  });
});
