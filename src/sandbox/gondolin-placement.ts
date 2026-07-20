import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";
import { ensureDirExists, isRecord } from "../utils/file-guards.js";
import type { GondolinPlacementRecord } from "./types.js";

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const MAX_PLACEMENT_FENCE_MS = 65 * 60 * 1000;

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_TIMESTAMP
  );
}

function isPlacementRecord(key: string, entry: unknown): entry is GondolinPlacementRecord {
  if (
    !key ||
    !isRecord(entry) ||
    entry.instanceId !== key ||
    !entry.instanceId ||
    typeof entry.worker !== "string" ||
    !entry.worker ||
    (entry.sessionId !== undefined && (typeof entry.sessionId !== "string" || !entry.sessionId)) ||
    !isValidTimestamp(entry.leaseExpiresAt) ||
    !isValidTimestamp(entry.updatedAt)
  ) {
    return false;
  }
  return (
    entry.leaseExpiresAt >= entry.updatedAt &&
    entry.leaseExpiresAt - entry.updatedAt <= MAX_PLACEMENT_FENCE_MS
  );
}

function isPlacementTable(value: unknown): value is Record<string, GondolinPlacementRecord> {
  return (
    isRecord(value) && Object.entries(value).every(([key, entry]) => isPlacementRecord(key, entry))
  );
}

/**
 * Durable instanceId → worker map. mikan is the only scheduler, so a single
 * atomically-replaced JSON file under the state dir is the source of truth.
 * Read/write failures are fatal to the operation: continuing without a
 * trustworthy fencing watermark could create two workspace writers.
 */
export class GondolinPlacementStore {
  private path?: string;
  private table = new Map<string, GondolinPlacementRecord>();

  private readyPath(path: string): string {
    return `${path}.ready`;
  }

  configure(path?: string): void {
    if (!path) {
      this.path = undefined;
      this.table.clear();
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (existsSync(this.readyPath(path))) {
          throw new Error(
            `Cannot read Gondolin placement table ${path}: durable placement state is missing`,
            { cause: err },
          );
        }
        this.path = path;
        this.table.clear();
        return;
      }
      throw new Error(
        `Cannot read Gondolin placement table ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Cannot parse Gondolin placement table ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (!isPlacementTable(parsed)) {
      throw new Error(`Invalid Gondolin placement table shape at ${path}`);
    }
    const next = new Map<string, GondolinPlacementRecord>();
    for (const record of Object.values(parsed)) next.set(record.instanceId, record);
    if (!existsSync(this.readyPath(path))) {
      atomicWritePrivateFile(this.readyPath(path), "ready\n");
    }
    this.path = path;
    this.table = next;
  }

  get(instanceId: string): GondolinPlacementRecord | undefined {
    return this.table.get(instanceId);
  }

  entries(): GondolinPlacementRecord[] {
    return Array.from(this.table.values(), (record) => ({ ...record }));
  }

  set(
    instanceId: string,
    worker: string,
    leaseExpiresAt: number,
    sessionId?: string,
    updatedAt = Date.now(),
  ): void {
    const record: GondolinPlacementRecord = {
      instanceId,
      worker,
      ...(sessionId ? { sessionId } : {}),
      leaseExpiresAt,
      updatedAt,
    };
    if (!isPlacementRecord(instanceId, record)) {
      throw new Error("Invalid Gondolin placement record");
    }
    const next = new Map(this.table);
    next.set(instanceId, record);
    try {
      this.persist(next);
    } catch (err) {
      // Preserve the conservative in-process fence even when durable storage
      // failed; callers still receive the error and must not report success.
      this.table = next;
      throw err;
    }
    this.table = next;
  }

  /** Refresh the fencing watermark without moving the placement. */
  touch(instanceId: string, leaseExpiresAt: number, updatedAt = Date.now()): void {
    if (!instanceId || !isValidTimestamp(leaseExpiresAt)) {
      throw new Error("Invalid Gondolin placement watermark");
    }
    const record = this.table.get(instanceId);
    if (!record || leaseExpiresAt <= record.leaseExpiresAt) return;
    const updated = { ...record, leaseExpiresAt, updatedAt };
    if (!isPlacementRecord(instanceId, updated)) {
      throw new Error("Invalid Gondolin placement watermark");
    }
    const next = new Map(this.table);
    next.set(instanceId, updated);
    try {
      this.persist(next);
    } catch (err) {
      this.table = next;
      throw err;
    }
    this.table = next;
  }

  delete(instanceId: string): void {
    if (!this.table.has(instanceId)) return;
    const next = new Map(this.table);
    next.delete(instanceId);
    this.persist(next);
    this.table = next;
  }

  private persist(table: Map<string, GondolinPlacementRecord>): void {
    if (!this.path) return;
    ensureDirExists(dirname(this.path));
    const snapshot = Object.fromEntries(table);
    atomicWritePrivateFile(this.path, JSON.stringify(snapshot, null, 2) + "\n");
    const readyPath = this.readyPath(this.path);
    if (!existsSync(readyPath)) atomicWritePrivateFile(readyPath, "ready\n");
  }
}

export const gondolinPlacements = new GondolinPlacementStore();
