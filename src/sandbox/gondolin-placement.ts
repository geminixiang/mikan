import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as log from "../log.js";
import { ensureDirExists, isRecord } from "../utils/file-guards.js";

/**
 * Where one conversation's runtime lives in the fleet, plus the fencing
 * watermark failover must respect: the worker-side lease cannot outlive
 * `leaseExpiresAt` (mikan clock), after which the old worker's janitor has
 * stopped the runtime and the shared-storage single-writer rule allows a
 * placement elsewhere.
 */
export interface GondolinPlacementRecord {
  instanceId: string;
  worker: string;
  leaseExpiresAt: number;
  updatedAt: number;
}

function isPlacementTable(value: unknown): value is Record<string, GondolinPlacementRecord> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.instanceId === "string" &&
      typeof entry.worker === "string" &&
      typeof entry.leaseExpiresAt === "number" &&
      typeof entry.updatedAt === "number",
  );
}

/**
 * Durable instanceId → worker map. mikan is the only scheduler, so a single
 * atomically-replaced JSON file under the state dir is the source of truth.
 */
export class GondolinPlacementStore {
  private path?: string;
  private table = new Map<string, GondolinPlacementRecord>();

  configure(path?: string): void {
    this.path = path;
    this.table.clear();
    if (!path) return;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isPlacementTable(parsed)) throw new Error("unexpected placement table shape");
      for (const record of Object.values(parsed)) this.table.set(record.instanceId, record);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.logWarning(
          "Starting with an empty Gondolin placement table",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  get(instanceId: string): GondolinPlacementRecord | undefined {
    return this.table.get(instanceId);
  }

  list(): GondolinPlacementRecord[] {
    return Array.from(this.table.values());
  }

  countByWorker(worker: string): number {
    return this.list().filter((record) => record.worker === worker).length;
  }

  set(instanceId: string, worker: string, leaseExpiresAt: number): void {
    this.table.set(instanceId, { instanceId, worker, leaseExpiresAt, updatedAt: Date.now() });
    this.persist();
  }

  /** Refresh the fencing watermark without moving the placement. */
  touch(instanceId: string, leaseExpiresAt: number): void {
    const record = this.table.get(instanceId);
    if (!record || leaseExpiresAt <= record.leaseExpiresAt) return;
    record.leaseExpiresAt = leaseExpiresAt;
    record.updatedAt = Date.now();
    this.persist();
  }

  delete(instanceId: string): void {
    if (this.table.delete(instanceId)) this.persist();
  }

  private persist(): void {
    if (!this.path) return;
    try {
      ensureDirExists(dirname(this.path));
      const snapshot = Object.fromEntries(this.table);
      const staged = `${this.path}.tmp`;
      writeFileSync(staged, JSON.stringify(snapshot, null, 2) + "\n");
      renameSync(staged, this.path);
    } catch (err) {
      log.logWarning(
        "Failed to persist Gondolin placement table",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export const gondolinPlacements = new GondolinPlacementStore();
