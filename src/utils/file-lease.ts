import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FileLeaseOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  label?: string;
}

/** Acquire a process-aware directory lease for a short synchronous transaction. */
export function acquireFileLease(lockPath: string, options: FileLeaseOptions = {}): () => void {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryMs = options.retryMs ?? 25;
  const staleMs = options.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(join(lockPath, "owner"), `${token}\n`, { mode: 0o600 });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => releaseFileLease(lockPath, token);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (fileLeaseIsStale(lockPath, staleMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring ${options.label ?? "file"} lock: ${lockPath}`, {
          cause: error,
        });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }
}

function releaseFileLease(lockPath: string, token: string): void {
  try {
    if (readFileSync(join(lockPath, "owner"), "utf8").trim() === token) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function fileLeaseIsStale(lockPath: string, staleMs: number): boolean {
  let ownerKnown = false;
  let ownerAlive = false;
  try {
    const owner = readFileSync(join(lockPath, "owner"), "utf8").trim();
    const pid = Number(owner.split(":", 1)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      ownerKnown = true;
      try {
        process.kill(pid, 0);
        ownerAlive = true;
      } catch (error) {
        if (isErrno(error, "EPERM")) ownerAlive = true;
      }
    }
  } catch {
    // The owner file may not have been written before its process died.
  }
  try {
    const oldEnough = Date.now() - statSync(lockPath).mtimeMs >= staleMs;
    return ownerKnown ? !ownerAlive : oldEnough;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
