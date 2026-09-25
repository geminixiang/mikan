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
import { atomicWritePrivateFile } from "../file-guards.js";

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function optionalAnnotations(source: { details?: unknown; usage?: unknown }): {
  details?: JsonValue;
  usage?: Usage;
} {
  return {
    details: source.details !== undefined ? jsonValue(source.details) : undefined,
    usage: source.usage as Usage | undefined,
  };
}

export class V4FileWriter {
  readonly #lines: string[];
  #seq = 0;

  constructor(header: Record<string, unknown>) {
    this.#lines = [JSON.stringify(header)];
  }

  entry(entry: PiEntry): void {
    this.#lines.push(JSON.stringify({ kind: "entry", ...entry, seq: ++this.#seq }));
  }

  set(namespace: string, key: string, value: unknown): void {
    this.#write("value", "set", namespace, key, value);
  }

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

export async function commitMigration(options: {
  filePath: string;
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
