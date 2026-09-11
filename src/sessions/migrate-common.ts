/**
 * Shared mechanics for the offline session migrations (`migrate-v3.ts`,
 * `migrate-pi-084.ts`): candidate discovery, Pi v4 JSONL encoding, and the
 * verify-then-replace commit that keeps the original file as a backup.
 */
import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Entry as PiEntry, JsonValue } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { atomicWritePrivateFile } from "../utils/file-guards.js";

/** Deep-copy a JSON-derived value into a `JsonValue`. */
export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * `details` and `usage` are optional on v4 compaction and branch-summary
 * entries; absent keys must stay absent rather than become `undefined`.
 */
export function optionalAnnotations(source: { details?: unknown; usage?: unknown }): {
  details?: JsonValue;
  usage?: Usage;
} {
  return {
    ...(source.details !== undefined ? { details: jsonValue(source.details) } : {}),
    ...(source.usage !== undefined ? { usage: source.usage as Usage } : {}),
  };
}

/** Accumulates Pi v4 JSONL lines, numbering mutations consecutively from 1. */
export class V4FileWriter {
  readonly #lines: string[];
  #seq = 0;

  constructor(header: Record<string, unknown>) {
    this.#lines = [JSON.stringify(header)];
  }

  entry(entry: PiEntry): void {
    this.#lines.push(JSON.stringify({ kind: "entry", ...entry, seq: ++this.#seq }));
  }

  /** Replace the value at `namespace`/`key`. */
  set(namespace: string, key: string, value: unknown): void {
    this.#write("value", "set", namespace, key, value);
  }

  /** Append to the list at `namespace`/`key`. */
  append(namespace: string, key: string, value: unknown): void {
    this.#write("list", "append", namespace, key, value);
  }

  #write(kind: string, op: string, namespace: string, key: string, value: unknown): void {
    this.#lines.push(JSON.stringify({ kind, op, seq: ++this.#seq, namespace, key, value }));
  }

  toString(): string {
    return `${this.#lines.join("\n")}\n`;
  }
}

function collectSessionFiles(
  dir: string,
  isCandidate: (path: string) => boolean,
  found: string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectSessionFiles(path, isCandidate, found);
    else if (entry.name.endsWith(".jsonl") && isCandidate(path)) found.push(path);
  }
}

/** Recursively collect `.jsonl` files under `root` that `isCandidate` accepts. */
export function findSessionFiles(root: string, isCandidate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  collectSessionFiles(root, isCandidate, found);
  return found;
}

function backupAlreadyLinked(sourcePath: string, backupPath: string): boolean {
  if (!existsSync(backupPath)) return false;
  const source = statSync(sourcePath);
  const backup = statSync(backupPath);
  if (source.dev === backup.dev && source.ino === backup.ino) return true;
  throw new Error(`Backup already exists: ${backupPath}`);
}

/**
 * Write `encoded` beside `filePath`, verify it, then swap it in — hard-linking
 * the untouched original to `backupPath` first. A failed verification, or a
 * source that changed while the migration ran, leaves the original in place.
 */
export async function commitMigration(options: {
  filePath: string;
  /** Bytes read before parsing; the source must be unchanged at swap time. */
  sourceBytes: Buffer;
  encoded: string;
  tempPath: string;
  backupPath: string;
  verify: (candidatePath: string) => Promise<void>;
}): Promise<void> {
  const { filePath, tempPath, backupPath } = options;
  const backupLinked = backupAlreadyLinked(filePath, backupPath);
  atomicWritePrivateFile(tempPath, options.encoded);
  try {
    await options.verify(tempPath);
    if (!readFileSync(filePath).equals(options.sourceBytes)) {
      throw new Error("source changed during migration");
    }
    if (!backupLinked) linkSync(filePath, backupPath);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw new Error(`Migration failed for ${filePath}`, { cause: error });
  }
}
