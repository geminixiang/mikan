import * as log from "../log.js";
import type { GondolinRemoteSettings, GondolinRemoteWorkerSettings } from "../types.js";
import { SandboxError } from "./errors.js";
import { gondolinPlacements, type GondolinPlacementStore } from "./gondolin-placement.js";
import {
  GondolinRemoteConnection,
  GondolinWorkerUnreachableError,
  type GondolinRemoteOverrides,
} from "./gondolin-remote.js";
import {
  GondolinRuntimeGoneError,
  type GondolinRuntimeHandle,
  type GondolinRuntimeSpec,
  type GondolinRuntimeTransport,
} from "./gondolin-worker-client.js";
import type { ExecResult } from "./types.js";

const LEASE_TTL_SECONDS = 300;
const QUEUE_WAIT_SECONDS = 60;
const QUEUE_POLL_MS = 2000;

/** The connection surface the fleet needs from each worker. */
export interface GondolinWorkerConnection {
  health(): Promise<Record<string, unknown>>;
  ensure(instanceId: string, spec: GondolinRuntimeSpec): Promise<GondolinRuntimeHandle>;
  stop(
    handle: Pick<GondolinRuntimeHandle, "workerPid" | "sessionId" | "instanceId">,
  ): Promise<void>;
  exec(
    handle: GondolinRuntimeHandle,
    command: string,
    options?: { env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ExecResult>;
  isRuntimeAlive(handle: GondolinRuntimeHandle): Promise<boolean>;
  listRuntimes(): Promise<Array<{ sessionId: string; instanceId: string }>>;
  dispose(): void;
}

interface FleetWorker {
  name: string;
  settings: GondolinRemoteWorkerSettings;
  connection: GondolinWorkerConnection;
}

interface GondolinFleetOverrides {
  createConnection?: (
    worker: GondolinRemoteWorkerSettings,
    connectionOverrides: GondolinRemoteOverrides,
  ) => GondolinWorkerConnection;
  placements?: GondolinPlacementStore;
  connectionOverrides?: GondolinRemoteOverrides;
  now?: () => number;
  queuePollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function normalizeWorkers(settings: GondolinRemoteSettings): GondolinRemoteWorkerSettings[] {
  const inline = settings.workers ?? [{ url: settings.url as string }];
  return inline.map((worker) => ({
    ...worker,
    name: worker.name ?? worker.url,
    caFile: worker.caFile ?? settings.caFile,
    certFile: worker.certFile ?? settings.certFile,
    keyFile: worker.keyFile ?? settings.keyFile,
    workspaceRoot: worker.workspaceRoot ?? settings.workspaceRoot,
    maxRuntimes: worker.maxRuntimes ?? settings.maxRuntimes,
  }));
}

/**
 * Places each conversation's runtime on one worker of the fleet and keeps it
 * there (sticky placement). Failover to another worker happens only when the
 * placed worker is unreachable AND its lease fencing watermark has passed —
 * the point after which the old worker's janitor has provably stopped the
 * runtime, so shared storage never sees two writers.
 */
class GondolinFleetClient implements GondolinRuntimeTransport {
  private settings?: GondolinRemoteSettings;
  private workers = new Map<string, FleetWorker>();
  private connectionOverrides: GondolinRemoteOverrides = {};
  private placements: GondolinPlacementStore = gondolinPlacements;
  private leaseTtlMs = LEASE_TTL_SECONDS * 1000;
  private queueWaitMs = QUEUE_WAIT_SECONDS * 1000;
  private queuePollMs = QUEUE_POLL_MS;
  private now: () => number = Date.now;
  private sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  configure(settings?: GondolinRemoteSettings, overrides?: GondolinFleetOverrides): void {
    for (const worker of this.workers.values()) worker.connection.dispose();
    this.workers.clear();
    this.settings = settings;
    this.placements = overrides?.placements ?? gondolinPlacements;
    this.now = overrides?.now ?? Date.now;
    this.sleep = overrides?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.queuePollMs = overrides?.queuePollMs ?? QUEUE_POLL_MS;
    this.connectionOverrides = overrides?.connectionOverrides ?? {};
    this.leaseTtlMs = (overrides?.connectionOverrides?.leaseTtlSeconds ?? LEASE_TTL_SECONDS) * 1000;
    this.queueWaitMs = (settings?.queueWaitSeconds ?? QUEUE_WAIT_SECONDS) * 1000;
    if (!settings) return;
    if (!settings.workers?.length && !settings.url) {
      return; // not configured; validate() reports the actionable error
    }
    const createConnection =
      overrides?.createConnection ??
      ((worker: GondolinRemoteWorkerSettings, connectionOverrides: GondolinRemoteOverrides) =>
        new GondolinRemoteConnection(worker, connectionOverrides));
    for (const worker of normalizeWorkers(settings)) {
      const name = worker.name as string;
      const connection = createConnection(worker, {
        ...overrides?.connectionOverrides,
        onLeaseActivity: (instanceId, expiresAtMs) => {
          if (this.placements.get(instanceId)?.worker === name) {
            this.placements.touch(instanceId, expiresAtMs);
          }
        },
      });
      this.workers.set(name, { name, settings: worker, connection });
    }
  }

  isConfigured(): boolean {
    return this.workers.size > 0;
  }

  /** Names of statically-configured workers with no workspaceRoot (startup guard). */
  workersMissingWorkspaceRoot(): string[] {
    return Array.from(this.workers.values())
      .filter((worker) => !worker.settings.workspaceRoot)
      .map((worker) => worker.name);
  }

  /**
   * Attach a dial-home worker at runtime (the gateway calls this when a
   * worker registers). The factory receives the fleet's connection overrides
   * plus the lease-watermark callback, mirroring configure()'s wiring.
   */
  attachWorker(
    settings: GondolinRemoteWorkerSettings,
    createConnection: (overrides: GondolinRemoteOverrides) => GondolinWorkerConnection,
  ): void {
    const name = settings.name ?? settings.url;
    this.workers.get(name)?.connection.dispose();
    const connection = createConnection({
      ...this.connectionOverrides,
      onLeaseActivity: (instanceId, expiresAtMs) => {
        if (this.placements.get(instanceId)?.worker === name) {
          this.placements.touch(instanceId, expiresAtMs);
        }
      },
    });
    this.workers.set(name, { name, settings: { ...settings, name }, connection });
  }

  /**
   * Detach a dial-home worker (disconnect). Placements survive: their lease
   * watermarks keep fencing failover until expiry, exactly as for an
   * unreachable static worker.
   */
  detachWorker(name: string): void {
    const worker = this.workers.get(name);
    if (!worker) return;
    worker.connection.dispose();
    this.workers.delete(name);
  }

  imageSelector(): string | undefined {
    return this.settings?.imageSelector;
  }

  /** At least one worker must answer for the sandbox mode to come up. */
  async health(): Promise<Array<{ worker: string; health?: Record<string, unknown> }>> {
    const report = await Promise.all(
      Array.from(this.workers.values()).map(async (worker) => {
        try {
          return { worker: worker.name, health: await worker.connection.health() };
        } catch {
          return { worker: worker.name };
        }
      }),
    );
    if (report.length > 0 && !report.some((entry) => entry.health)) {
      throw new SandboxError("Error: no gondolin remote worker is reachable");
    }
    return report;
  }

  async ensure(instanceId: string, spec: GondolinRuntimeSpec): Promise<GondolinRuntimeHandle> {
    const placed = this.placements.get(instanceId);
    if (placed) {
      const worker = this.workers.get(placed.worker);
      if (worker) {
        try {
          return await this.ensureOn(worker, instanceId, spec);
        } catch (err) {
          if (!(err instanceof GondolinWorkerUnreachableError)) throw err;
          this.assertFailoverAllowed(instanceId, placed.worker, placed.leaseExpiresAt, err);
        }
      } else {
        this.assertFailoverAllowed(
          instanceId,
          placed.worker,
          placed.leaseExpiresAt,
          new GondolinWorkerUnreachableError("worker is no longer configured"),
        );
      }
      log.logWarning(
        `Gondolin worker '${placed.worker}' lost runtime for '${instanceId}'; failing over`,
      );
    }
    const worker = await this.selectWorker();
    return this.ensureOn(worker, instanceId, spec);
  }

  async stop(
    handle: Pick<GondolinRuntimeHandle, "workerPid" | "sessionId" | "instanceId" | "workerName">,
  ): Promise<void> {
    const worker = this.workerFor(handle.workerName);
    if (!worker) {
      // the worker left the fleet config; its janitor stops the runtime when
      // the lease expires, and the record keeps fencing until then
      return;
    }
    try {
      await worker.connection.stop(handle);
      this.placements.delete(handle.instanceId);
    } catch (err) {
      if (err instanceof GondolinWorkerUnreachableError) {
        // cannot confirm the stop; keep the placement so its watermark still
        // fences any failover, and let the daemon's expiry janitor finish it
        log.logWarning(
          `Gondolin worker '${worker.name}' unreachable while stopping '${handle.instanceId}'; leaving it to lease expiry`,
        );
        return;
      }
      throw err;
    }
  }

  async exec(
    handle: GondolinRuntimeHandle,
    command: string,
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    const worker = this.workerFor(handle.workerName);
    if (!worker) throw new GondolinRuntimeGoneError("worker is no longer configured");
    return worker.connection.exec(handle, command, options);
  }

  async isRuntimeAlive(handle: GondolinRuntimeHandle): Promise<boolean> {
    const worker = this.workerFor(handle.workerName);
    if (!worker) return false;
    return worker.connection.isRuntimeAlive(handle);
  }

  /**
   * Fleet reconciliation: a runtime whose conversation is placed on a
   * different worker is a stray from a superseded placement — stop it. A
   * runtime with no placement at all (crash between daemon ensure and the
   * placement write) is adopted instead of killed.
   */
  async reconcile(): Promise<void> {
    for (const worker of this.workers.values()) {
      let runtimes: Array<{ sessionId: string; instanceId: string }>;
      try {
        runtimes = await worker.connection.listRuntimes();
      } catch {
        continue; // unreachable workers reconcile on a later sweep
      }
      for (const runtime of runtimes) {
        const record = this.placements.get(runtime.instanceId);
        if (!record) {
          log.logInfo(
            `Adopting unplaced Gondolin runtime '${runtime.instanceId}' on worker '${worker.name}'`,
          );
          this.placements.set(runtime.instanceId, worker.name, this.now() + this.leaseTtlMs);
          continue;
        }
        if (record.worker === worker.name) continue;
        log.logInfo(
          `Stopping stray Gondolin runtime '${runtime.instanceId}' on worker '${worker.name}' (placed on '${record.worker}')`,
        );
        try {
          await worker.connection.stop({
            sessionId: runtime.sessionId,
            instanceId: runtime.instanceId,
            workerPid: 0,
          });
        } catch (err) {
          log.logWarning(
            `Failed to stop stray runtime '${runtime.instanceId}' on '${worker.name}'`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  private async ensureOn(
    worker: FleetWorker,
    instanceId: string,
    spec: GondolinRuntimeSpec,
  ): Promise<GondolinRuntimeHandle> {
    const handle = await worker.connection.ensure(instanceId, spec);
    this.placements.set(instanceId, worker.name, this.now() + this.leaseTtlMs);
    return { ...handle, workerName: worker.name };
  }

  private assertFailoverAllowed(
    instanceId: string,
    workerName: string,
    leaseExpiresAt: number,
    cause: Error,
  ): void {
    const remainingMs = leaseExpiresAt - this.now();
    if (remainingMs <= 0) return;
    // Failing over earlier could put a second writable VM on the same shared
    // workspace: the old worker may be alive behind a partition, and its
    // daemon only stops the runtime once the lease expires.
    throw new SandboxError(
      `Error: Gondolin worker '${workerName}' is unreachable (${cause.message}); ` +
        `retrying '${instanceId}' elsewhere in ${Math.ceil(remainingMs / 1000)}s once its lease has expired`,
    );
  }

  private async selectWorker(): Promise<FleetWorker> {
    const deadline = this.now() + this.queueWaitMs;
    for (;;) {
      let best: { worker: FleetWorker; load: number } | undefined;
      let reachable = 0;
      let draining = 0;
      let full = 0;
      for (const worker of this.workers.values()) {
        if (worker.settings.draining) {
          draining += 1;
          continue;
        }
        let active: number;
        try {
          const health = await worker.connection.health();
          active = typeof health.activeRuntimes === "number" ? health.activeRuntimes : 0;
        } catch {
          continue;
        }
        reachable += 1;
        const cap = worker.settings.maxRuntimes;
        if (cap !== undefined && active >= cap) {
          full += 1;
          continue;
        }
        const load = cap !== undefined ? active / cap : active / Number.MAX_SAFE_INTEGER;
        if (!best || load < best.load) best = { worker, load };
      }
      if (best) return best.worker;
      if (reachable === 0 && draining === 0) {
        throw new SandboxError("Error: no gondolin remote worker is reachable");
      }
      if (full === 0) {
        throw new SandboxError("Error: every gondolin remote worker is draining or unreachable");
      }
      if (this.now() >= deadline) {
        throw new SandboxError(
          `Error: all gondolin remote workers are at capacity (waited ${Math.round(this.queueWaitMs / 1000)}s)`,
        );
      }
      await this.sleep(this.queuePollMs);
    }
  }

  private workerFor(workerName: string | undefined): FleetWorker | undefined {
    if (!workerName) return undefined;
    return this.workers.get(workerName);
  }
}

export const gondolinFleet = new GondolinFleetClient();
