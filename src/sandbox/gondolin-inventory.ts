import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "../log.js";
import { ensureDirExists, isRecord, readJsonFileIfExists } from "../utils/file-guards.js";
import { execSimple } from "./utils.js";

/**
 * Durable record of one Gondolin VM launched by this mikan install. Written
 * beside the state dir (never inside the workspace) so a mikan process killed
 * with SIGKILL — where Gondolin's own process-exit hook cannot run — leaves
 * enough behind to find and stop the orphaned VM runner on the next startup.
 */
interface GondolinRuntimeRecord {
  /** Gondolin session id (`vm.id`); also names the record file. */
  sessionId: string;
  /** mikan session key (vault key) the runtime was created for. */
  instanceId: string;
  /** mikan process that owned the runtime. */
  ownerPid: number;
  /** Host pid of the active VM runner process (QEMU/krun), if started. */
  runnerPid: number | null;
  createdAt: string;
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
    typeof value.createdAt === "string"
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

  record(entry: { sessionId: string; instanceId: string; runnerPid: number | null }): void {
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
   * Startup reconciliation: stop VM runners orphaned by a previous mikan
   * process that died without cleanup, drop stale records, and let Gondolin
   * collect its own stale session registry entries. Idempotent — a second run
   * finds an empty inventory.
   */
  async reconcile(): Promise<void> {
    if (!this.dir) return;
    ensureDirExists(this.dir);
    let killed = 0;
    let stale = 0;
    let skipped = 0;
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
      if (!record) {
        rmSync(path, { force: true });
        stale += 1;
        continue;
      }
      if (record.ownerPid === process.pid) continue;
      if (this.isPidAlive(record.ownerPid)) {
        skipped += 1;
        continue;
      }
      const outcome = record.runnerPid === null ? "gone" : await this.stopOrphan(record);
      if (outcome === "alive") {
        log.logWarning(
          `Orphaned Gondolin runner ${record.runnerPid} survived SIGKILL; keeping record '${record.sessionId}'`,
        );
        continue;
      }
      if (outcome === "killed") killed += 1;
      else stale += 1;
      rmSync(path, { force: true });
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

  private isPidAlive(pid: number): boolean {
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
