import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import * as log from "../log.js";
import type { GondolinRemoteSettings, GondolinRemoteWorkerSettings } from "../types.js";
import { SandboxError } from "./errors.js";
import { gondolinPlacements, type GondolinPlacementStore } from "./gondolin-placement.js";
import {
  GONDOLIN_FENCING_GRACE_SECONDS,
  GondolinClockSkewError,
  GondolinRemoteConnection,
  GondolinWorkerUnreachableError,
  type GondolinRemoteOverrides,
} from "./gondolin-remote.js";
import { GondolinRuntimeGoneError } from "./gondolin-recovery.js";
import type {
  GondolinRuntimeHandle,
  GondolinRuntimeSpec,
  GondolinRuntimeTransport,
} from "./gondolin-worker-client.js";
import type { ExecResult, GondolinFleetDiagnostics } from "./types.js";

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
  /** Dial-home workers may replace themselves on reconnect; static identities may not be shadowed. */
  dynamic: boolean;
  /** Non-empty when the worker's shared workspace failed its usability probe. */
  workspaceError?: string;
  certificateExpiresAt?: number;
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
  expectedWorkerNames?: () => readonly string[];
}

function validateWorkerUrl(worker: GondolinRemoteWorkerSettings): void {
  let url: URL;
  try {
    url = new URL(worker.url);
  } catch {
    throw new SandboxError(`Error: gondolin remote worker '${worker.name}' has an invalid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "dialhome:") {
    throw new SandboxError(
      `Error: gondolin remote worker '${worker.name}' URL must use https or dialhome`,
    );
  }
  const rootPath = url.protocol === "https:" ? "/" : "";
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== rootPath ||
    url.search ||
    url.hash
  ) {
    throw new SandboxError(
      `Error: gondolin remote worker '${worker.name}' URL must contain only scheme, host, and optional port`,
    );
  }
}

function normalizeWorkers(settings: GondolinRemoteSettings): GondolinRemoteWorkerSettings[] {
  const inline = settings.workers ?? [{ url: settings.url as string }];
  const normalized = inline.map((worker) => ({
    ...worker,
    name: worker.name?.trim() || worker.url,
    caFile: worker.caFile ?? settings.caFile,
    certFile: worker.certFile ?? settings.certFile,
    keyFile: worker.keyFile ?? settings.keyFile,
    workspaceRoot: worker.workspaceRoot ?? settings.workspaceRoot,
    maxRuntimes: worker.maxRuntimes ?? settings.maxRuntimes,
  }));
  const names = new Set<string>();
  for (const worker of normalized) {
    validateWorkerUrl(worker);
    if (names.has(worker.name)) {
      throw new SandboxError(`Error: duplicate gondolin remote worker name '${worker.name}'`);
    }
    names.add(worker.name);
    if (
      worker.maxRuntimes !== undefined &&
      (!Number.isSafeInteger(worker.maxRuntimes) || worker.maxRuntimes < 1)
    ) {
      throw new SandboxError(
        `Error: gondolin remote worker '${worker.name}' maxRuntimes must be a positive integer`,
      );
    }
  }
  return normalized;
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
  private lifecycleTails = new Map<string, Promise<void>>();
  private placementTail: Promise<void> = Promise.resolve();
  private reservations = new Map<string, number>();
  private expectedWorkerNames: () => readonly string[] = () => [];
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
    this.lifecycleTails.clear();
    this.placementTail = Promise.resolve();
    this.reservations.clear();
    this.settings = settings;
    this.placements = overrides?.placements ?? gondolinPlacements;
    this.now = overrides?.now ?? Date.now;
    this.sleep = overrides?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.queuePollMs = overrides?.queuePollMs ?? QUEUE_POLL_MS;
    this.expectedWorkerNames = overrides?.expectedWorkerNames ?? (() => []);
    this.connectionOverrides = overrides?.connectionOverrides ?? {};
    this.leaseTtlMs =
      ((overrides?.connectionOverrides?.leaseTtlSeconds ?? LEASE_TTL_SECONDS) +
        GONDOLIN_FENCING_GRACE_SECONDS) *
      1000;
    this.queueWaitMs = (settings?.queueWaitSeconds ?? QUEUE_WAIT_SECONDS) * 1000;
    if (
      settings?.queueWaitSeconds !== undefined &&
      (!Number.isFinite(settings.queueWaitSeconds) || settings.queueWaitSeconds < 0)
    ) {
      throw new SandboxError("Error: gondolin remote queueWaitSeconds must be non-negative");
    }
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
            this.placements.touch(instanceId, expiresAtMs, this.now());
          }
        },
      });
      this.workers.set(name, { name, settings: worker, connection, dynamic: false });
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
    const name = settings.name?.trim() || settings.url;
    if (
      settings.maxRuntimes !== undefined &&
      (!Number.isSafeInteger(settings.maxRuntimes) || settings.maxRuntimes < 1)
    ) {
      throw new SandboxError(
        `Error: gondolin remote worker '${name}' maxRuntimes must be a positive integer`,
      );
    }
    const existing = this.workers.get(name);
    if (existing && !existing.dynamic) {
      throw new SandboxError(
        `Error: dial-home gondolin worker '${name}' conflicts with a statically configured worker`,
      );
    }
    existing?.connection.dispose();
    const connection = createConnection({
      ...this.connectionOverrides,
      onLeaseActivity: (instanceId, expiresAtMs) => {
        if (this.placements.get(instanceId)?.worker === name) {
          this.placements.touch(instanceId, expiresAtMs, this.now());
        }
      },
    });
    this.workers.set(name, { name, settings: { ...settings, name }, connection, dynamic: true });
  }

  /**
   * Record a worker's shared-workspace health (the gateway pushes this from
   * register and ping frames). A degraded worker keeps its runtimes and its
   * connection, but new placements skip it and runtime operations fail fast
   * with the probe's diagnosis instead of hanging on a dead mount.
   */
  setWorkspaceHealth(name: string, error?: string): void {
    const worker = this.workers.get(name);
    if (!worker) return;
    worker.workspaceError = error || undefined;
  }

  /**
   * Detach a dial-home worker (disconnect). Placements survive: their lease
   * watermarks keep fencing failover until expiry, exactly as for an
   * unreachable static worker.
   */
  updateWorkerCertificateExpiry(name: string, expiresAt: number): void {
    const worker = this.workers.get(name);
    if (worker) worker.certificateExpiresAt = expiresAt;
  }

  detachWorker(name: string): void {
    const worker = this.workers.get(name);
    if (!worker || !worker.dynamic) return;
    worker.connection.dispose();
    this.workers.delete(name);
  }

  imageSelector(): string | undefined {
    return this.settings?.imageSelector;
  }

  private certificateExpiry(worker: FleetWorker): number | undefined {
    if (worker.certificateExpiresAt !== undefined) return worker.certificateExpiresAt;
    if (!worker.settings.certFile) return undefined;
    try {
      return new X509Certificate(readFileSync(worker.settings.certFile)).validToDate.getTime();
    } catch {
      return undefined;
    }
  }

  async diagnostics(now = this.now()): Promise<GondolinFleetDiagnostics> {
    const workers = await Promise.all(
      Array.from(this.workers.values(), async (worker) => {
        const certificateExpiresAt = this.certificateExpiry(worker);
        try {
          const health = await worker.connection.health();
          return {
            name: worker.name,
            reachable: true,
            ...(typeof health.activeRuntimes === "number"
              ? { activeRuntimes: health.activeRuntimes }
              : {}),
            ...(worker.settings.maxRuntimes !== undefined
              ? { maxRuntimes: worker.settings.maxRuntimes }
              : {}),
            draining: worker.settings.draining === true,
            ...(worker.workspaceError ? { workspaceError: worker.workspaceError } : {}),
            ...(typeof health.protocolVersion === "number"
              ? { protocolVersion: health.protocolVersion }
              : {}),
            ...(typeof health.clockSkewMs === "number"
              ? {
                  clockSkewMs: health.clockSkewMs,
                  ...(typeof health.clockUncertaintyMs === "number"
                    ? { clockUncertaintyMs: health.clockUncertaintyMs }
                    : {}),
                }
              : {}),
            ...(certificateExpiresAt !== undefined
              ? {
                  certificateExpiresAt: new Date(certificateExpiresAt).toISOString(),
                  expiresWithin30Days: certificateExpiresAt - now <= 30 * 24 * 3600 * 1000,
                }
              : {}),
          };
        } catch (error) {
          return {
            name: worker.name,
            reachable: false,
            ...(worker.settings.maxRuntimes !== undefined
              ? { maxRuntimes: worker.settings.maxRuntimes }
              : {}),
            draining: worker.settings.draining === true,
            ...(worker.workspaceError ? { workspaceError: worker.workspaceError } : {}),
            ...(error instanceof GondolinClockSkewError
              ? {
                  clockSkewMs: error.clockSkewMs,
                  clockUncertaintyMs: error.clockUncertaintyMs,
                }
              : {}),
            ...(certificateExpiresAt !== undefined
              ? {
                  certificateExpiresAt: new Date(certificateExpiresAt).toISOString(),
                  expiresWithin30Days: certificateExpiresAt - now <= 30 * 24 * 3600 * 1000,
                }
              : {}),
          };
        }
      }),
    );
    return {
      workers,
      placements: this.placements.entries().map((record) => ({
        instanceId: record.instanceId,
        worker: record.worker,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        fenceExpiresAt: new Date(record.leaseExpiresAt).toISOString(),
        fenceRemainingMs: Math.max(0, record.leaseExpiresAt - now),
      })),
    };
  }

  async waitForExpectedWorkers(timeoutMs = 30_000): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new SandboxError("Error: Gondolin worker wait timeout must be non-negative");
    }
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const missing = Array.from(this.expectedWorkerNames()).filter(
        (name) => !this.workers.has(name),
      );
      if (missing.length === 0) return;
      if (this.now() >= deadline) {
        throw new SandboxError(
          `Error: timed out waiting for enrolled Gondolin workers: ${missing.toSorted().join(", ")}`,
        );
      }
      await this.sleep(Math.min(200, Math.max(1, deadline - this.now())));
    }
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
    return this.withInstanceLock(instanceId, () => this.ensureSerialized(instanceId, spec));
  }

  private async ensureSerialized(
    instanceId: string,
    spec: GondolinRuntimeSpec,
  ): Promise<GondolinRuntimeHandle> {
    const placed = this.placements.get(instanceId);
    if (placed) {
      const worker = this.workers.get(placed.worker);
      if (worker) {
        try {
          return await this.ensureOn(worker, instanceId, spec, false);
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
    const worker = await this.reserveWorker(spec);
    try {
      return await this.ensureOn(worker, instanceId, spec, true);
    } finally {
      this.releaseReservation(worker.name);
    }
  }

  async stop(
    handle: Pick<GondolinRuntimeHandle, "workerPid" | "sessionId" | "instanceId" | "workerName">,
  ): Promise<void> {
    await this.withInstanceLock(handle.instanceId, () => this.stopSerialized(handle));
  }

  /**
   * Prove that no configured worker still runs an instance before storage or
   * identity migration. Unlike normal handle-based stop, uncertainty is fatal:
   * every worker must answer, every matching runtime must stop, and a second
   * inventory pass must confirm absence before durable placement is removed.
   */
  async fenceInstance(instanceId: string): Promise<void> {
    if (!instanceId) throw new SandboxError("Error: Gondolin instance id must not be empty");
    await this.withInstanceLock(instanceId, () => this.fenceInstanceSerialized(instanceId));
  }

  private async fenceInstanceSerialized(instanceId: string): Promise<void> {
    const missingExpected = Array.from(this.expectedWorkerNames()).filter(
      (name) => !this.workers.has(name),
    );
    if (missingExpected.length > 0) {
      throw new SandboxError(
        `Error: cannot fence Gondolin instance '${instanceId}': enrolled workers are not connected: ${missingExpected.toSorted().join(", ")}`,
      );
    }
    if (this.workers.size === 0) {
      throw new SandboxError(
        `Error: cannot fence Gondolin instance '${instanceId}': no worker inventory is connected`,
      );
    }
    const placement = this.placements.get(instanceId);
    if (placement && !this.workers.has(placement.worker)) {
      throw new SandboxError(
        `Error: cannot fence Gondolin instance '${instanceId}': placed worker '${placement.worker}' is not configured`,
      );
    }

    for (const worker of this.workers.values()) {
      let runtimes: Array<{ sessionId: string; instanceId: string }>;
      try {
        runtimes = await worker.connection.listRuntimes();
      } catch (error) {
        throw new SandboxError(
          `Error: cannot fence Gondolin instance '${instanceId}': worker '${worker.name}' inventory is unreachable`,
          [error instanceof Error ? error.message : String(error)],
        );
      }
      for (const runtime of runtimes) {
        if (runtime.instanceId !== instanceId) continue;
        try {
          await worker.connection.stop({ ...runtime, workerPid: 0 });
        } catch (error) {
          throw new SandboxError(
            `Error: cannot fence Gondolin instance '${instanceId}' on worker '${worker.name}'`,
            [error instanceof Error ? error.message : String(error)],
          );
        }
      }
      let remaining: Array<{ sessionId: string; instanceId: string }>;
      try {
        remaining = await worker.connection.listRuntimes();
      } catch (error) {
        throw new SandboxError(
          `Error: cannot verify Gondolin fence for '${instanceId}' on worker '${worker.name}'`,
          [error instanceof Error ? error.message : String(error)],
        );
      }
      if (remaining.some((runtime) => runtime.instanceId === instanceId)) {
        throw new SandboxError(
          `Error: Gondolin instance '${instanceId}' still exists on worker '${worker.name}' after fencing`,
        );
      }
    }
    this.placements.delete(instanceId);
  }

  private async stopSerialized(
    handle: Pick<GondolinRuntimeHandle, "workerPid" | "sessionId" | "instanceId" | "workerName">,
  ): Promise<void> {
    const placement = this.placements.get(handle.instanceId);
    if (placement?.sessionId && placement.sessionId !== handle.sessionId) return;
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
          `Gondolin worker '${worker.name}' unreachable while stopping '${handle.instanceId}'; leaving it to the lease fence`,
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
    this.assertWorkspaceUsable(worker);
    log.logInfo(`Gondolin execution '${handle.instanceId}' routed to worker '${worker.name}'`);
    return worker.connection.exec(handle, command, options);
  }

  async isRuntimeAlive(handle: GondolinRuntimeHandle): Promise<boolean> {
    const worker = this.workerFor(handle.workerName);
    if (!worker) return false;
    return worker.connection.isRuntimeAlive(handle);
  }

  /**
   * Fleet reconciliation: only a runtime matching a durable placement and
   * session identity may survive. A runtime on another worker is stray; one
   * with no placement is unauthorised because write-ahead placement now
   * precedes every remote create. Neither is safe to adopt.
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
        await this.withInstanceLock(runtime.instanceId, () =>
          this.reconcileRuntime(worker, runtime),
        );
      }
    }
  }

  private async reconcileRuntime(
    worker: FleetWorker,
    runtime: { sessionId: string; instanceId: string },
  ): Promise<void> {
    const record = this.placements.get(runtime.instanceId);
    if (!record) {
      log.logInfo(
        `Stopping unplaced Gondolin runtime '${runtime.instanceId}' on '${worker.name}' (no durable placement authority)`,
      );
      try {
        await worker.connection.stop({
          sessionId: runtime.sessionId,
          instanceId: runtime.instanceId,
          workerPid: 0,
        });
      } catch (err) {
        log.logWarning(
          `Failed to stop unplaced runtime '${runtime.instanceId}' on '${worker.name}'`,
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    if (record.worker === worker.name && !record.sessionId) {
      this.placements.set(
        runtime.instanceId,
        worker.name,
        Math.max(record.leaseExpiresAt, this.now() + this.leaseTtlMs),
        runtime.sessionId,
        this.now(),
      );
      return;
    }
    if (record.worker === worker.name && record.sessionId === runtime.sessionId) return;
    log.logInfo(
      `Stopping stray Gondolin runtime '${runtime.instanceId}' on '${worker.name}' (placed on '${record.worker}')`,
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

  private async reserveWorker(spec: GondolinRuntimeSpec): Promise<FleetWorker> {
    return this.withPlacementLock(async () => {
      const worker = await this.selectWorker(spec);
      this.reservations.set(worker.name, (this.reservations.get(worker.name) ?? 0) + 1);
      return worker;
    });
  }

  private releaseReservation(workerName: string): void {
    const remaining = (this.reservations.get(workerName) ?? 1) - 1;
    if (remaining > 0) this.reservations.set(workerName, remaining);
    else this.reservations.delete(workerName);
  }

  private async withPlacementLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.placementTail;
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.placementTail = tail;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withInstanceLock<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(instanceId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lifecycleTails.set(instanceId, tail);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleTails.get(instanceId) === tail) this.lifecycleTails.delete(instanceId);
    }
  }

  private async ensureOn(
    worker: FleetWorker,
    instanceId: string,
    spec: GondolinRuntimeSpec,
    writeAhead: boolean,
  ): Promise<GondolinRuntimeHandle> {
    this.assertWorkspaceUsable(worker);
    // New placement only: persist the selected worker and longest possible
    // lease fence before any remote request can create a runtime. Existing
    // placements are already fenced; extending them before a failed liveness
    // probe would postpone failover forever.
    if (writeAhead) {
      this.placements.set(
        instanceId,
        worker.name,
        this.now() + this.leaseTtlMs,
        undefined,
        this.now(),
      );
    }
    const handle = await worker.connection.ensure(instanceId, spec);
    this.placements.set(
      instanceId,
      worker.name,
      this.now() + this.leaseTtlMs,
      handle.sessionId,
      this.now(),
    );
    return { ...handle, workerName: worker.name };
  }

  /**
   * Fail fast — with the probe's diagnosis — instead of dispatching work that
   * would hang on a dead shared-workspace mount. Deliberately NOT a
   * GondolinWorkerUnreachableError: a broken mount must not trigger failover,
   * because the workspace is shared and likely broken for every worker.
   */
  private assertWorkspaceUsable(worker: FleetWorker): void {
    if (!worker.workspaceError) return;
    throw new SandboxError(
      `Error: Gondolin worker '${worker.name}' has an unusable shared workspace: ` +
        `${worker.workspaceError} (fix the mount on the worker; health refreshes with its next heartbeat)`,
    );
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
        `retrying '${instanceId}' elsewhere in ${Math.ceil(remainingMs / 1000)}s once its lease fence has passed`,
    );
  }

  private async selectWorker(spec: GondolinRuntimeSpec): Promise<FleetWorker> {
    const deadline = this.now() + this.queueWaitMs;
    for (;;) {
      let best: { worker: FleetWorker; load: number } | undefined;
      let reachable = 0;
      let draining = 0;
      let full = 0;
      let incompatible = 0;
      const degraded: string[] = [];
      for (const worker of this.workers.values()) {
        if (worker.settings.draining) {
          draining += 1;
          continue;
        }
        if (worker.workspaceError) {
          degraded.push(`'${worker.name}': ${worker.workspaceError}`);
          continue;
        }
        let active: number;
        let workspaceError: string | undefined;
        try {
          const health = await worker.connection.health();
          active =
            (typeof health.activeRuntimes === "number" ? health.activeRuntimes : 0) +
            (this.reservations.get(worker.name) ?? 0);
          workspaceError =
            typeof health.workspaceError === "string" && health.workspaceError
              ? health.workspaceError
              : undefined;
          if (
            spec.network &&
            (typeof health.protocolVersion !== "number" || health.protocolVersion < 2)
          ) {
            incompatible += 1;
            continue;
          }
        } catch {
          continue;
        }
        reachable += 1;
        if (workspaceError) {
          // static workers report probe results via /v1/health only
          degraded.push(`'${worker.name}': ${workspaceError}`);
          continue;
        }
        const cap = worker.settings.maxRuntimes;
        if (cap !== undefined && active >= cap) {
          full += 1;
          continue;
        }
        const load = cap !== undefined ? active / cap : active / Number.MAX_SAFE_INTEGER;
        if (!best || load < best.load) best = { worker, load };
      }
      if (best) return best.worker;
      if (reachable === 0 && incompatible === 0 && draining === 0 && degraded.length === 0) {
        throw new SandboxError("Error: no gondolin remote worker is reachable");
      }
      if (full === 0) {
        if (incompatible > 0) {
          throw new SandboxError(
            "Error: no reachable Gondolin worker supports the requested network policy (protocol 2 required)",
          );
        }
        const detail = degraded.length > 0 ? ` — degraded: ${degraded.join("; ")}` : "";
        throw new SandboxError(
          `Error: every gondolin remote worker is draining, degraded, or unreachable${detail}`,
        );
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
