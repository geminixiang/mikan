import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as log from "../src/log.js";
import { gondolinFleet, type GondolinWorkerConnection } from "../src/sandbox/gondolin-fleet.js";
import { GondolinPlacementStore } from "../src/sandbox/gondolin-placement.js";
import {
  GondolinClockSkewError,
  GondolinWorkerUnreachableError,
} from "../src/sandbox/gondolin-remote.js";
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
  protocolVersion = 2;

  constructor(
    readonly name: string,
    private readonly onLeaseActivity?: (instanceId: string, expiresAtMs: number) => void,
    private readonly leaseTtlMs = 300_000,
  ) {}

  private assertReachable(): void {
    if (!this.reachable) throw new GondolinWorkerUnreachableError(`${this.name} unreachable`);
  }

  failEnsure = false;
  healthError?: Error;
  workspaceError?: string;

  async health(): Promise<Record<string, unknown>> {
    this.assertReachable();
    if (this.healthError) throw this.healthError;
    return {
      protocolVersion: this.protocolVersion,
      activeRuntimes: this.runtimes.size,
      ...(this.workspaceError ? { workspaceError: this.workspaceError } : {}),
    };
  }

  async ensure(instanceId: string, _spec: GondolinRuntimeSpec): Promise<GondolinRuntimeHandle> {
    this.assertReachable();
    if (this.failEnsure) throw new GondolinWorkerUnreachableError(`${this.name} ensure failed`);
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
      workerPid: 1,
      fingerprint: _spec.fingerprint,
    };
  }

  async stop(handle: Pick<GondolinRuntimeHandle, "sessionId" | "instanceId">): Promise<void> {
    this.assertReachable();
    if (this.runtimes.get(handle.instanceId)?.sessionId === handle.sessionId) {
      this.runtimes.delete(handle.instanceId);
    }
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

  test.each([
    ["http://worker.test", "must use https or dialhome"],
    ["https://user@worker.test", "must contain only scheme, host, and optional port"],
    ["https://worker.test/base", "must contain only scheme, host, and optional port"],
    ["https://worker.test?token=x", "must contain only scheme, host, and optional port"],
    ["not a url", "has an invalid URL"],
  ])("rejects ambiguous worker URL %s", (url, expected) => {
    expect(() => configureFleet([{ name: "bad", url }])).toThrow(expected);
  });

  test("rejects duplicate worker identities and invalid admission settings", () => {
    expect(() => configureFleet([{ name: "same" }, { name: "same" }])).toThrow(
      "duplicate gondolin remote worker name 'same'",
    );
    expect(() => configureFleet([{ name: "a", maxRuntimes: 0 }])).toThrow(
      "maxRuntimes must be a positive integer",
    );
    expect(() => configureFleet([{ name: "a" }], { queueWaitSeconds: -1 })).toThrow(
      "queueWaitSeconds must be non-negative",
    );
  });

  test("waitForExpectedWorkers times out with every missing durable identity", async () => {
    gondolinFleet.configure(undefined, {
      placements,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
      expectedWorkerNames: () => ["enrolled-a", "enrolled-b"],
    });

    await expect(gondolinFleet.waitForExpectedWorkers(10)).rejects.toThrow(
      "timed out waiting for enrolled Gondolin workers: enrolled-a, enrolled-b",
    );
  });

  test("fenceInstance requires every durable enrolled identity to be connected", async () => {
    gondolinFleet.configure(undefined, {
      placements,
      expectedWorkerNames: () => ["enrolled-a"],
    });

    await expect(gondolinFleet.fenceInstance("legacy-c1")).rejects.toThrow(
      "enrolled workers are not connected: enrolled-a",
    );
  });

  test("fenceInstance refuses to infer absence from an empty fleet", async () => {
    gondolinFleet.configure(undefined, { placements });

    await expect(gondolinFleet.fenceInstance("legacy-c1")).rejects.toThrow(
      "no worker inventory is connected",
    );
  });

  test("fenceInstance stops every legacy runtime before deleting placement authority", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const handle = await gondolinFleet.ensure("legacy-c1", SPEC);
    const other = workers.get(handle.workerName === "a" ? "b" : "a")!;
    other.runtimes.set("legacy-c1", { sessionId: "stray-s1", instanceId: "legacy-c1" });

    await gondolinFleet.fenceInstance("legacy-c1");

    expect(workers.get("a")!.runtimes.has("legacy-c1")).toBe(false);
    expect(workers.get("b")!.runtimes.has("legacy-c1")).toBe(false);
    expect(placements.get("legacy-c1")).toBeUndefined();
  });

  test("fenceInstance retains authority when any worker inventory is unreachable", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    await gondolinFleet.ensure("legacy-c1", SPEC);
    workers.get("b")!.reachable = false;

    await expect(gondolinFleet.fenceInstance("legacy-c1")).rejects.toThrow(
      "worker 'b' inventory is unreachable",
    );
    expect(placements.get("legacy-c1")).toBeDefined();
  });

  test("fenceInstance rejects placement owned by an unconfigured worker", async () => {
    configureFleet([{ name: "a" }]);
    placements.set("legacy-c1", "removed-worker", clock.now + 300_000, "old-session", clock.now);

    await expect(gondolinFleet.fenceInstance("legacy-c1")).rejects.toThrow(
      "placed worker 'removed-worker' is not configured",
    );
    expect(placements.get("legacy-c1")).toBeDefined();
  });

  test("diagnostics report worker health and durable fences without connection secrets", async () => {
    configureFleet([{ name: "a", maxRuntimes: 2 }, { name: "b" }]);
    const handle = await gondolinFleet.ensure("c1", SPEC);
    workers.get("b")!.reachable = false;
    workers.get("a")!.healthError = new GondolinClockSkewError(12_000, 10);

    gondolinFleet.updateWorkerCertificateExpiry("a", clock.now + 20 * 24 * 3600 * 1000);
    gondolinFleet.updateWorkerCertificateExpiry("b", clock.now + 90 * 24 * 3600 * 1000);
    const diagnostics = await gondolinFleet.diagnostics(clock.now);

    expect(diagnostics.workers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "a",
          reachable: false,
          maxRuntimes: 2,
          clockSkewMs: 12_000,
          clockUncertaintyMs: 10,
          expiresWithin30Days: true,
        }),
        expect.objectContaining({ name: "b", reachable: false, expiresWithin30Days: false }),
      ]),
    );
    expect(diagnostics.placements).toEqual([
      expect.objectContaining({
        instanceId: "c1",
        worker: handle.workerName,
        sessionId: handle.sessionId,
        fenceRemainingMs: 345_000,
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("unused.pem");
    expect(JSON.stringify(diagnostics)).not.toContain("https://");
  });

  test("dial-home workers cannot shadow statically configured identities", () => {
    configureFleet([{ name: "static" }]);

    expect(() =>
      gondolinFleet.attachWorker(
        { name: "static", url: "dialhome://static" },
        () => workers.get("static") as FakeWorker,
      ),
    ).toThrow("conflicts with a statically configured worker");
    expect(gondolinFleet.isConfigured()).toBe(true);
  });

  test("network policy placement skips protocol-v1 workers", async () => {
    configureFleet([{ name: "old" }, { name: "new" }]);
    workers.get("old")!.protocolVersion = 1;

    const handle = await gondolinFleet.ensure("policy", {
      ...SPEC,
      network: { blockInternalRanges: true },
    });

    expect(handle.workerName).toBe("new");
  });

  test("network policy fails clearly when only protocol-v1 workers are reachable", async () => {
    configureFleet([{ name: "old" }]);
    workers.get("old")!.protocolVersion = 1;

    await expect(
      gondolinFleet.ensure("policy", { ...SPEC, network: { blockInternalRanges: true } }),
    ).rejects.toThrow("protocol 2 required");
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

  test("a degraded workspace excludes the worker from new placements", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    gondolinFleet.setWorkspaceHealth("a", "workspace root /mnt/x is not responding");

    const placed = await gondolinFleet.ensure("c1", SPEC);
    expect(placed.workerName).toBe("b");
  });

  test("every workspace degraded fails placement with the probe diagnosis", async () => {
    configureFleet([{ name: "a" }]);
    gondolinFleet.setWorkspaceHealth("a", "workspace root /mnt/x is not responding");

    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(
      /degraded: 'a': workspace root \/mnt\/x is not responding/,
    );
  });

  test("exec and ensure fail fast on a degraded worker instead of hanging", async () => {
    configureFleet([{ name: "a" }]);
    const handle = await gondolinFleet.ensure("c1", SPEC);

    gondolinFleet.setWorkspaceHealth("a", "workspace root /mnt/x is not responding");
    await expect(gondolinFleet.exec(handle, "pwd")).rejects.toThrow(/unusable shared workspace/);
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(/unusable shared workspace/);
    // a broken shared mount must not trigger failover
    expect(placements.get("c1")?.worker).toBe("a");

    gondolinFleet.setWorkspaceHealth("a", undefined);
    await expect(gondolinFleet.exec(handle, "pwd")).resolves.toMatchObject({ code: 0 });
  });

  test("a workspaceError in /v1/health also excludes static workers", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    workers.get("a")!.workspaceError = "workspace root /mnt/x is unusable: stale file handle";

    const placed = await gondolinFleet.ensure("c1", SPEC);
    expect(placed.workerName).toBe("b");
  });

  test("persists a placement fence before remote runtime creation", async () => {
    configureFleet([{ name: "a" }]);
    const worker = workers.get("a") as FakeWorker;
    const originalEnsure = worker.ensure.bind(worker);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.ensure = async (instanceId, spec) => {
      await gate;
      return originalEnsure(instanceId, spec);
    };

    const pending = gondolinFleet.ensure("c1", SPEC);
    await vi.waitFor(() => expect(placements.get("c1")?.worker).toBe("a"));
    expect(placements.get("c1")?.sessionId).toBeUndefined();
    release();
    const handle = await pending;
    expect(placements.get("c1")?.sessionId).toBe(handle.sessionId);
  });

  test("a failed remote ensure keeps its conservative placement fence", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    workers.get("a")!.failEnsure = true;

    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow("ensure failed");

    expect(placements.get("c1")?.worker).toBe("a");
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow("lease fence has passed");
    expect(workers.get("b")?.runtimes.size).toBe(0);
  });

  test("serializes admission so concurrent conversations respect capacity", async () => {
    configureFleet(
      [
        { name: "a", maxRuntimes: 1 },
        { name: "b", maxRuntimes: 1 },
      ],
      { queueWaitSeconds: 1 },
    );
    const workerA = workers.get("a") as FakeWorker;
    const workerB = workers.get("b") as FakeWorker;
    const originalEnsureA = workerA.ensure.bind(workerA);
    const originalEnsureB = workerB.ensure.bind(workerB);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    workerA.ensure = async (instanceId, spec) => {
      started += 1;
      await gate;
      return originalEnsureA(instanceId, spec);
    };
    workerB.ensure = async (instanceId, spec) => {
      started += 1;
      await gate;
      return originalEnsureB(instanceId, spec);
    };

    const first = gondolinFleet.ensure("c1", SPEC);
    const second = gondolinFleet.ensure("c2", SPEC);
    await vi.waitFor(() => expect(started).toBe(2));
    release();

    const [one, two] = await Promise.all([first, second]);
    expect(new Set([one.workerName, two.workerName])).toEqual(new Set(["a", "b"]));
    expect(workers.get("a")?.runtimes.size).toBe(1);
    expect(workers.get("b")?.runtimes.size).toBe(1);
  });

  test("serializes concurrent ensures for one conversation", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const worker = workers.get("a") as FakeWorker;
    const originalEnsure = worker.ensure.bind(worker);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    worker.ensure = async (instanceId, spec) => {
      calls += 1;
      if (calls === 1) await gate;
      return originalEnsure(instanceId, spec);
    };

    const first = gondolinFleet.ensure("c1", SPEC);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = gondolinFleet.ensure("c1", SPEC);
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst();
    const [one, two] = await Promise.all([first, second]);
    expect(one.workerName).toBe("a");
    expect(two.workerName).toBe("a");
    expect(one.sessionId).toBe(two.sessionId);
  });

  test("a stale handle cannot delete a replacement runtime's placement", async () => {
    configureFleet([{ name: "a" }]);
    const stale = await gondolinFleet.ensure("c1", SPEC);
    const worker = workers.get("a") as FakeWorker;
    worker.runtimes.delete("c1");
    const replacement = await gondolinFleet.ensure("c1", { ...SPEC, fingerprint: "fp-2" });
    expect(replacement.sessionId).not.toBe(stale.sessionId);

    await gondolinFleet.stop(stale);

    expect(placements.get("c1")?.sessionId).toBe(replacement.sessionId);
    expect(worker.runtimes.get("c1")?.sessionId).toBe(replacement.sessionId);
  });

  test("serializes stop behind an in-flight ensure", async () => {
    configureFleet([{ name: "a" }]);
    const worker = workers.get("a") as FakeWorker;
    const originalEnsure = worker.ensure.bind(worker);
    let releaseEnsure!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    worker.ensure = async (instanceId, spec) => {
      await gate;
      return originalEnsure(instanceId, spec);
    };

    const ensure = gondolinFleet.ensure("c1", SPEC);
    await Promise.resolve();
    const stop = gondolinFleet.stop({
      instanceId: "c1",
      sessionId: "a-s1",
      workerPid: 1,
      workerName: "a",
    });
    expect(worker.stopped).toEqual([]);

    releaseEnsure();
    await ensure;
    await stop;
    expect(worker.stopped).toEqual(["c1"]);
    expect(placements.get("c1")).toBeUndefined();
  });

  test("failover waits for the lease watermark, then moves the conversation", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const placed = await gondolinFleet.ensure("c1", SPEC);
    expect(placed.workerName).toBe("a");

    workers.get("a")!.reachable = false;

    // inside the fencing window: refused, with the wait surfaced
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(/lease fence has passed/);

    clock.now += 301_000;
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(/lease fence has passed/);

    clock.now += 45_000; // lease TTL plus fencing grace passed
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

  test("exec logs and routes by the handle's worker", async () => {
    const logSpy = vi.spyOn(log, "logInfo").mockImplementation(() => {});
    configureFleet([{ name: "a" }, { name: "b" }]);
    const first = await gondolinFleet.ensure("c1", SPEC);

    const result = await gondolinFleet.exec(first, "hostname");
    expect(result.stdout.trim()).toBe(first.workerName);
    expect(logSpy).toHaveBeenCalledWith(
      `Gondolin execution 'c1' routed to worker '${first.workerName}'`,
    );

    await gondolinFleet.stop(first);
    expect(placements.get("c1")).toBeUndefined();
    expect(workers.get(first.workerName as string)?.stopped).toContain("c1");
    logSpy.mockRestore();
  });

  test("reconcile stops strays and runtimes without durable placement authority", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    // stray: placed on b, but a still hosts a runtime for it
    placements.set("c1", "b", clock.now + 300_000);
    await workers.get("a")!.ensure("c1", SPEC);
    // unplaced: exists on b with no write-ahead record, so authority cannot be proven
    await workers.get("b")!.ensure("c2", SPEC);

    await gondolinFleet.reconcile();

    expect(workers.get("a")?.stopped).toContain("c1");
    expect(workers.get("b")?.stopped).toContain("c2");
    expect(placements.get("c2")).toBeUndefined();
  });

  test("reconcile upgrades legacy placements with the live session identity", async () => {
    configureFleet([{ name: "a" }]);
    const runtime = await workers.get("a")!.ensure("legacy", SPEC);
    placements.set("legacy", "a", clock.now + 300_000);

    await gondolinFleet.reconcile();

    expect(placements.get("legacy")?.sessionId).toBe(runtime.sessionId);
  });

  test("placement storage fails closed on corruption or write failure", () => {
    const corruptPath = join(dir, "corrupt-placement.json");
    writeFileSync(corruptPath, "{not-json");
    const corrupt = new GondolinPlacementStore();
    expect(() => corrupt.configure(corruptPath)).toThrow("Cannot parse Gondolin placement table");

    const blockedPath = join(dir, "blocked");
    mkdirSync(blockedPath);
    const unwritable = new GondolinPlacementStore();
    unwritable.configure(join(blockedPath, "placement.json"));
    rmSync(blockedPath, { recursive: true });
    writeFileSync(blockedPath, "not a directory");
    expect(() => unwritable.set("c1", "a", clock.now + 300_000, "s1")).toThrow();
    expect(unwritable.get("c1")?.leaseExpiresAt).toBe(clock.now + 300_000);
  });

  test("placement storage rejects semantically corrupt records", () => {
    const cases: Record<string, unknown> = {
      mismatchedKey: {
        key: {
          instanceId: "other",
          worker: "a",
          leaseExpiresAt: clock.now,
          updatedAt: clock.now,
        },
      },
      emptyWorker: {
        c1: { instanceId: "c1", worker: "", leaseExpiresAt: clock.now, updatedAt: clock.now },
      },
      emptySession: {
        c1: {
          instanceId: "c1",
          worker: "a",
          sessionId: "",
          leaseExpiresAt: clock.now,
          updatedAt: clock.now,
        },
      },
      negativeFence: {
        c1: { instanceId: "c1", worker: "a", leaseExpiresAt: -1, updatedAt: clock.now },
      },
      fractionalFence: {
        c1: {
          instanceId: "c1",
          worker: "a",
          leaseExpiresAt: clock.now + 0.5,
          updatedAt: clock.now,
        },
      },
      outOfDateRange: {
        c1: {
          instanceId: "c1",
          worker: "a",
          leaseExpiresAt: Number.MAX_SAFE_INTEGER,
          updatedAt: clock.now,
        },
      },
      implausibleFenceDuration: {
        c1: {
          instanceId: "c1",
          worker: "a",
          leaseExpiresAt: clock.now + 66 * 60 * 1000,
          updatedAt: clock.now,
        },
      },
    };
    for (const [name, snapshot] of Object.entries(cases)) {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(snapshot));
      expect(() => new GondolinPlacementStore().configure(path), name).toThrow(
        "Invalid Gondolin placement table shape",
      );
    }

    expect(() => placements.set("", "a", clock.now)).toThrow("Invalid Gondolin placement");
    expect(() => placements.set("c1", "", clock.now)).toThrow("Invalid Gondolin placement");
    expect(() => placements.touch("c1", Number.NaN)).toThrow(
      "Invalid Gondolin placement watermark",
    );
  });

  test("failed placement reconfigure preserves the active in-memory fence", () => {
    placements.set("c1", "a", clock.now + 300_000, "s1");
    const corruptPath = join(dir, "replacement-corrupt.json");
    writeFileSync(corruptPath, "{bad");

    expect(() => placements.configure(corruptPath)).toThrow(
      "Cannot parse Gondolin placement table",
    );
    expect(placements.get("c1")).toMatchObject({ worker: "a", sessionId: "s1" });

    placements.touch("c1", clock.now + 400_000);
    const original = JSON.parse(readFileSync(join(dir, "placement.json"), "utf8"));
    expect(original.c1.leaseExpiresAt).toBe(clock.now + 400_000);
  });

  test("placement ready marker prevents silent authority reset after state loss", () => {
    placements.set("c1", "a", clock.now + 300_000, "s1");
    const path = join(dir, "placement.json");
    expect(statSync(`${path}.ready`).mode & 0o777).toBe(0o600);
    rmSync(path);

    const reloaded = new GondolinPlacementStore();
    expect(() => reloaded.configure(path)).toThrow("durable placement state is missing");
  });

  test("placement survives a fleet reconfigure via the store file", async () => {
    configureFleet([{ name: "a" }, { name: "b" }]);
    const placed = await gondolinFleet.ensure("c1", SPEC);

    // new store instance reads the same file (mikan restart)
    const reloaded = new GondolinPlacementStore();
    reloaded.configure(join(dir, "placement.json"));
    expect(reloaded.get("c1")?.worker).toBe(placed.workerName);
    expect(statSync(join(dir, "placement.json")).mode & 0o777).toBe(0o600);
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
