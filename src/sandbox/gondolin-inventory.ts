import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "../log.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "../utils/file-guards.js";
import { execSimple } from "./utils.js";

/**
 * Durable record of one Gondolin runtime. Written beside the state dir (never
 * inside the workspace) by whichever process owns the VM — the worker process
 * hosting it — so a crash that skips every exit hook still leaves enough
 * behind to adopt the runtime back or stop its orphaned VM runner.
 */
export interface GondolinRuntimeRecord {
  /** Gondolin session id (`vm.id`); also names the record file. */
  sessionId: string;
  /** mikan session key (vault key) the runtime was created for. */
  instanceId: string;
  /** Process that owns the runtime (the worker process). */
  ownerPid: number;
  /** Host pid of the active VM runner process (QEMU/krun), if started. */
  runnerPid: number | null;
  createdAt: string;
  /** Session IPC socket for adopting the runtime from a new mikan process. */
  socketPath?: string;
  /** Desired-runtime fingerprint the VM was created from. */
  fingerprint?: string;
}

interface GondolinInventoryOverrides {
  execFile?: (cmd: string, args: string[]) => Promise<string>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  gcSessions?: () => Promise<number>;
  killWaitMs?: number;
  killPollIntervalMs?: number;
}

function isGondolinRuntimeRecord(value: unknown): value is GondolinRuntimeRecord {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.instanceId === "string" &&
    typeof value.ownerPid === "number" &&
    (value.runnerPid === null || typeof value.runnerPid === "number") &&
    typeof value.createdAt === "string" &&
    (value.socketPath === undefined || typeof value.socketPath === "string") &&
    (value.fingerprint === undefined || typeof value.fingerprint === "string")
  );
}

async function defaultGcSessions(): Promise<number> {
  const { gcSessions } = await import("@earendil-works/gondolin");
  return gcSessions();
}

class GondolinRuntimeInventory {
  private dir?: string;
  private execFileImpl = execSimple;
  private killImpl: (pid: number, signal: NodeJS.Signals | 0) => void = (pid, signal) =>
    process.kill(pid, signal);
  private gcSessionsImpl = defaultGcSessions;
  private killWaitMs = 2000;
  private killPollIntervalMs = 100;
  private readonly liveRecords = new Map<string, GondolinRuntimeRecord>();

  configure(dir?: string, overrides?: GondolinInventoryOverrides): void {
    this.dir = dir;
    this.execFileImpl = overrides?.execFile ?? execSimple;
    this.killImpl = overrides?.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.gcSessionsImpl = overrides?.gcSessions ?? defaultGcSessions;
    this.killWaitMs = overrides?.killWaitMs ?? 2000;
    this.killPollIntervalMs = overrides?.killPollIntervalMs ?? 100;
    this.liveRecords.clear();
  }

  record(entry: {
    sessionId: string;
    instanceId: string;
    runnerPid: number | null;
    socketPath?: string;
    fingerprint?: string;
  }): void {
    if (!this.dir) return;
    const record: GondolinRuntimeRecord = {
      ...entry,
      ownerPid: process.pid,
      createdAt: new Date().toISOString(),
    };
    this.liveRecords.set(entry.sessionId, record);
    this.write(record);
  }

  /** Re-persist a runtime whose runner pid changed (late boot, runner restart). */
  refresh(sessionId: string, runnerPid: number | null): void {
    const record = this.liveRecords.get(sessionId);
    if (!record || record.runnerPid === runnerPid) return;
    record.runnerPid = runnerPid;
    this.write(record);
  }

  release(sessionId: string): void {
    this.liveRecords.delete(sessionId);
    if (!this.dir) return;
    try {
      rmSync(this.recordPath(sessionId), { force: true });
    } catch (err) {
      log.logWarning(
        `Failed to release Gondolin runtime record '${sessionId}'`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Newest worker-owned record for a session key whose owner is still alive —
   * a candidate for adoption instead of spawning a fresh worker. Records left
   * by dead owners are reaped on the spot.
   */
  async findAdoptable(instanceId: string): Promise<GondolinRuntimeRecord | undefined> {
    let newest: GondolinRuntimeRecord | undefined;
    for (const { record, path } of this.readRecords()) {
      if (record.instanceId !== instanceId || !record.socketPath) continue;
      if (!this.isPidAlive(record.ownerPid)) {
        await this.reapRecord(record, path);
        continue;
      }
      if (!newest || record.createdAt > newest.createdAt) newest = record;
    }
    return newest;
  }

  /** Reap one session's record if its owner is gone (e.g. after force-killing a worker). */
  async reapSession(sessionId: string): Promise<void> {
    for (const { record, path } of this.readRecords()) {
      if (record.sessionId !== sessionId) continue;
      if (!this.isPidAlive(record.ownerPid)) await this.reapRecord(record, path);
      return;
    }
  }

  /** Worker-owned records with live owners (runtimes surviving from a previous mikan). */
  listWorkerRecords(): GondolinRuntimeRecord[] {
    return this.readRecords()
      .map(({ record }) => record)
      .filter((record) => record.socketPath !== undefined && this.isPidAlive(record.ownerPid));
  }

  /**
   * mikan liveness signal for workers: a worker whose heartbeat goes stale
   * knows every mikan that could adopt it is gone and shuts itself down.
   */
  touchHeartbeat(): void {
    if (!this.dir) return;
    try {
      ensureDirExists(this.dir);
      writeFileSync(this.heartbeatPath() as string, new Date().toISOString() + "\n");
    } catch (err) {
      log.logWarning(
        "Failed to touch Gondolin heartbeat",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  heartbeatPath(): string | undefined {
    return this.dir ? join(this.dir, "heartbeat") : undefined;
  }

  directory(): string | undefined {
    return this.dir;
  }

  /**
   * Startup reconciliation: stop VM runners orphaned by a previous owner
   * process that died without cleanup, drop stale records, and let Gondolin
   * collect its own stale session registry entries. Runtimes whose owner is
   * still alive (workers surviving a mikan restart) are left for adoption.
   * Idempotent — a second run finds an empty inventory.
   */
  async reconcile(): Promise<void> {
    if (!this.dir) return;
    ensureDirExists(this.dir);
    let killed = 0;
    let stale = 0;
    let skipped = 0;
    for (const { record, path } of this.readRecords((badPath) => {
      rmSync(badPath, { force: true });
      stale += 1;
    })) {
      if (record.ownerPid === process.pid) continue;
      if (this.isPidAlive(record.ownerPid)) {
        skipped += 1;
        continue;
      }
      const outcome = await this.reapRecord(record, path);
      if (outcome === "killed") killed += 1;
      else if (outcome !== "alive") stale += 1;
    }
    try {
      await this.gcSessionsImpl();
    } catch (err) {
      log.logWarning(
        "Failed to collect Gondolin session registry",
        err instanceof Error ? err.message : String(err),
      );
    }
    log.logInfo(
      `Reconciled Gondolin runtimes (killed=${killed}, stale=${stale}, liveOwner=${skipped})`,
    );
  }

  /**
   * Reap one dead-owner record: stop its orphaned runner if it is still the
   * process we launched, then drop the record (kept only while the runner
   * refuses to die, so the next reconcile retries).
   */
  async reapRecord(
    record: GondolinRuntimeRecord,
    path = this.recordPath(record.sessionId),
  ): Promise<"killed" | "gone" | "reused" | "alive"> {
    const outcome = record.runnerPid === null ? "gone" : await this.stopOrphan(record);
    if (outcome === "alive") {
      log.logWarning(
        `Orphaned Gondolin runner ${record.runnerPid} survived SIGKILL; keeping record '${record.sessionId}'`,
      );
      return outcome;
    }
    rmSync(path, { force: true });
    return outcome;
  }

  private readRecords(
    onMalformed?: (path: string) => void,
  ): Array<{ record: GondolinRuntimeRecord; path: string }> {
    if (!this.dir) return [];
    ensureDirExists(this.dir);
    const entries: Array<{ record: GondolinRuntimeRecord; path: string }> = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      const path = join(this.dir, file);
      let record: GondolinRuntimeRecord | undefined;
      try {
        record = readJsonFileIfExists(
          path,
          isGondolinRuntimeRecord,
          (detail) => `Malformed Gondolin runtime record at ${path}: ${detail}`,
        );
      } catch (err) {
        log.logWarning(
          "Dropping malformed Gondolin runtime record",
          err instanceof Error ? err.message : String(err),
        );
      }
      if (record) entries.push({ record, path });
      else onMalformed?.(path);
    }
    return entries;
  }

  private async stopOrphan(
    record: GondolinRuntimeRecord,
  ): Promise<"killed" | "gone" | "reused" | "alive"> {
    const pid = record.runnerPid as number;
    if (!this.isPidAlive(pid)) return "gone";
    // Guard against pid reuse: only kill processes that still look like a
    // Gondolin runner (its guest assets and overlay disk live under paths
    // containing "gondolin").
    let command: string;
    try {
      command = await this.execFileImpl("ps", ["-p", String(pid), "-o", "command="]);
    } catch {
      return "gone";
    }
    if (!command.toLowerCase().includes("gondolin")) {
      log.logWarning(
        `Pid ${pid} from Gondolin runtime record '${record.sessionId}' no longer looks like a Gondolin runner; skipping kill`,
      );
      return "reused";
    }
    log.logInfo(
      `Stopping orphaned Gondolin runner ${pid} (session '${record.sessionId}', instance '${record.instanceId}')`,
    );
    this.signal(pid, "SIGTERM");
    if (await this.waitForExit(pid)) return "killed";
    this.signal(pid, "SIGKILL");
    return (await this.waitForExit(pid)) ? "killed" : "alive";
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killImpl(pid, signal);
    } catch {
      // process already gone
    }
  }

  isPidAlive(pid: number): boolean {
    try {
      this.killImpl(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + this.killWaitMs;
    while (this.isPidAlive(pid)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.killPollIntervalMs));
    }
    return true;
  }

  private write(record: GondolinRuntimeRecord): void {
    if (!this.dir) return;
    try {
      ensureDirExists(this.dir);
      writeFileSync(this.recordPath(record.sessionId), JSON.stringify(record, null, 2) + "\n");
    } catch (err) {
      log.logWarning(
        `Failed to persist Gondolin runtime record '${record.sessionId}'`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private recordPath(sessionId: string): string {
    return join(this.dir as string, `${sessionId}.json`);
  }
}

export const gondolinInventory = new GondolinRuntimeInventory();
