import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gondolinFleet, type GondolinWorkerConnection } from "../src/sandbox/gondolin-fleet.js";
import { GondolinPlacementStore } from "../src/sandbox/gondolin-placement.js";
import { GondolinWorkerUnreachableError } from "../src/sandbox/gondolin-remote.js";
import type {
  GondolinRuntimeHandle,
  GondolinRuntimeSpec,
} from "../src/sandbox/gondolin-worker-client.js";
import type { GondolinRemoteWorkerSettings } from "../src/types.js";
import type { GondolinRemoteOverrides } from "../src/sandbox/gondolin-remote.js";

const SPEC: GondolinRuntimeSpec = {
  image: "mikan-sandbox:latest",
  mounts: [],
  fingerprint: "fp-1",
};

/** In-memory stand-in for one mikan-worker daemon. */
class FakeWorker implements GondolinWorkerConnection {
  runtimes = new Map<string, { sessionId: string; instanceId: string }>();
  reachable = true;
  execLog: string[] = [];
  stopped: string[] = [];
  nextSession = 0;

  constructor(
    readonly name: string,
    private readonly onLeaseActivity?: (instanceId: string, expiresAtMs: number) => void,
    private readonly leaseTtlMs = 300_000,
  ) {}

  private assertReachable(): void {
    if (!this.reachable) throw new GondolinWorkerUnreachableError(`${this.name} unreachable`);
  }

  async health(): Promise<Record<string, unknown>> {
    this.assertReachable();
    return { activeRuntimes: this.runtimes.size };
  }

  async ensure(instanceId: string, _spec: GondolinRuntimeSpec): Promise<GondolinRuntimeHandle> {
    this.assertReachable();
    let runtime = this.runtimes.get(instanceId);
    if (!runtime) {
      this.nextSession += 1;
      runtime = { sessionId: `${this.name}-s${this.nextSession}`, instanceId };
      this.runtimes.set(instanceId, runtime);
    }
    this.onLeaseActivity?.(instanceId, Date.now() + this.leaseTtlMs);
    return {
      sessionId: runtime.sessionId,
      instanceId,
      socketPath: "",
      workerPid: 1,
      fingerprint: _spec.fingerprint,
    };
  }

  async stop(handle: Pick<GondolinRuntimeHandle, "sessionId" | "instanceId">): Promise<void> {
    this.assertReachable();
    this.runtimes.delete(handle.instanceId);
    this.stopped.push(handle.instanceId);
  }

  async exec(handle: GondolinRuntimeHandle, command: string) {
    this.assertReachable();
    if (!this.runtimes.has(handle.instanceId)) {
      throw new GondolinWorkerUnreachableError("runtime not here");
    }
    this.execLog.push(command);
    return { stdout: `${this.name}\n`, stderr: "", code: 0 };
  }

  async isRuntimeAlive(handle: GondolinRuntimeHandle): Promise<boolean> {
    return this.reachable && this.runtimes.has(handle.instanceId);
  }

  async listRuntimes(): Promise<Array<{ sessionId: string; instanceId: string }>> {
    this.assertReachable();
    return Array.from(this.runtimes.values());
  }

  dispose(): void {}
}

describe("Gondolin fleet", () => {
  let dir: string;
  let placements: GondolinPlacementStore;
  let workers: Map<string, FakeWorker>;
  let clock: { now: number };

  function configureFleet(
    workerSettings: Array<Partial<GondolinRemoteWorkerSettings> & { name: string }>,
    options: { queueWaitSeconds?: number } = {},
  ): void {
    gondolinFleet.configure(
      {
        imageSelector: "mikan-sandbox:latest",
        queueWaitSeconds: options.queueWaitSeconds ?? 1,
        workers: workerSettings.map((worker) => ({
          url: `https://${worker.name}.test`,
          certFile: "/unused.pem",
          keyFile: "/unused-key.pem",
          ...worker,
        })),
      },
      {
        placements,
        now: () => clock.now,
        queuePollMs: 5,
        sleep: async (ms) => {
          clock.now += Math.max(ms, 1000); // simulated waiting advances the clock
          await new Promise((resolve) => setTimeout(resolve, 1)); // let timers fire
        },
        createConnection: (
          settings: GondolinRemoteWorkerSettings,
          overrides: GondolinRemoteOverrides,
        ) => {
          const name = settings.name as string;
          const existing = workers.get(name);
          if (existing) return existing;
          const worker = new FakeWorker(name, overrides.onLeaseActivity);
          workers.set(name, worker);
          return worker;
        },
      },
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-fleet-"));
    placements = new GondolinPlacementStore();
    placements.configure(join(dir, "placement.json"));
    workers = new Map();
    clock = { now: Date.now() };
  });

  afterEach(() => {
    gondolinFleet.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  test("placement is sticky across ensures", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);

    const first = await gondolinFleet.ensure("c1", SPEC);
    for (let i = 0; i < 5; i += 1) {
      const again = await gondolinFleet.ensure("c1", SPEC);
      expect(again.workerName).toBe(first.workerName);
    }
    const hosting = workers.get(first.workerName as string) as FakeWorker;
    expect(hosting.runtimes.size).toBe(1);
  });

  test("new conversations spread toward the least-loaded worker", async () => {
    configureFleet([
      { name: "a", maxRuntimes: 2 },
      { name: "b", maxRuntimes: 2 },
    ]);

    await gondolinFleet.ensure("c1", SPEC);
    await gondolinFleet.ensure("c2", SPEC);
    await gondolinFleet.ensure("c3", SPEC);

    expect(workers.get("a")?.runtimes.size).toBeGreaterThan(0);
    expect(workers.get("b")?.runtimes.size).toBeGreaterThan(0);
  });

  test("draining workers accept no new placements but keep existing ones", async () => {
    configureFleet([{ name: "a" }]);
    await gondolinFleet.ensure("c1", SPEC);

    configureFleet([{ name: "a", draining: true }, { name: "b" }]);

    // sticky ensure stays on the draining worker
    const sticky = await gondolinFleet.ensure("c1", SPEC);
    expect(sticky.workerName).toBe("a");

    // new conversation lands elsewhere
    const fresh = await gondolinFleet.ensure("c2", SPEC);
    expect(fresh.workerName).toBe("b");
  });

  test("every worker draining fails new placements clearly", async () => {
    configureFleet([{ name: "a", draining: true }]);
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow("draining");
  });

  test("failover waits for the lease watermark, then moves the conversation", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const placed = await gondolinFleet.ensure("c1", SPEC);
    expect(placed.workerName).toBe("a");

    workers.get("a")!.reachable = false;

    // inside the fencing window: refused, with the wait surfaced
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(/lease has expired/);

    clock.now += 301_000; // watermark passed
    const failedOver = await gondolinFleet.ensure("c1", SPEC);
    expect(failedOver.workerName).toBe("b");
    expect(placements.get("c1")?.worker).toBe("b");
  });

  test("queue-waits for capacity and takes the freed slot", async () => {
    configureFleet([{ name: "a", maxRuntimes: 1 }], { queueWaitSeconds: 30 });
    await gondolinFleet.ensure("c1", SPEC);

    // free the slot while c2 is queued: fake sleeping also drops c1
    const worker = workers.get("a") as FakeWorker;
    const originalSleep = worker.runtimes.delete.bind(worker.runtimes);
    setTimeout(() => originalSleep("c1"), 0);

    const handle = await gondolinFleet.ensure("c2", SPEC);
    expect(handle.workerName).toBe("a");
  });

  test("queue-wait times out when nothing frees up", async () => {
    configureFleet([{ name: "a", maxRuntimes: 1 }], { queueWaitSeconds: 2 });
    await gondolinFleet.ensure("c1", SPEC);

    await expect(gondolinFleet.ensure("c2", SPEC)).rejects.toThrow("at capacity");
  });

  test("exec and stop route by the handle's worker", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const first = await gondolinFleet.ensure("c1", SPEC);

    const result = await gondolinFleet.exec(first, "hostname");
    expect(result.stdout.trim()).toBe(first.workerName);

    await gondolinFleet.stop(first);
    expect(placements.get("c1")).toBeUndefined();
    expect(workers.get(first.workerName as string)?.stopped).toContain("c1");
  });

  test("reconcile stops strays and adopts unplaced runtimes", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    // stray: placed on b, but a still hosts a runtime for it
    placements.set("c1", "b", clock.now + 300_000);
    await workers.get("a")!.ensure("c1", SPEC);
    // unplaced: exists on b with no record (crash before the placement write)
    await workers.get("b")!.ensure("c2", SPEC);

    await gondolinFleet.reconcile();

    expect(workers.get("a")?.stopped).toContain("c1");
    expect(placements.get("c2")?.worker).toBe("b");
  });

  test("placement survives a fleet reconfigure via the store file", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const placed = await gondolinFleet.ensure("c1", SPEC);

    // new store instance reads the same file (mikan restart)
    const reloaded = new GondolinPlacementStore();
    reloaded.configure(join(dir, "placement.json"));
    expect(reloaded.get("c1")?.worker).toBe(placed.workerName);
  });

  test("lease renewals advance the fencing watermark", async () => {
    configureFleet([{ name: "a" }]);
    await gondolinFleet.ensure("c1", SPEC);
    const before = placements.get("c1")?.leaseExpiresAt as number;

    // a later renewal reported by the connection pushes the watermark out
    const worker = workers.get("a") as FakeWorker;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await worker.ensure("c1", SPEC);

    expect(placements.get("c1")?.leaseExpiresAt).toBeGreaterThanOrEqual(before);
  });
});
